import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_OK, EXIT_PARCIAL, EXIT_TOTAL, exitCodeFor, runSyncCycle, type CycleJob } from "../sync-runner";
import {
  createDbRecorder,
  createHttpRecorder,
  redactSecrets,
  summarizeJobResult,
  withCronTelemetry,
  type SyncJobId,
  type SyncRunRecorder,
  type SyncRunResult,
} from "../sync-telemetry";

// Valores falsos, mas no formato real, para provar que nunca vazam.
const ENV = {
  CRON_SECRET: "cron-secret-0123456789abcdef",
  DATABASE_URL: "postgresql://obaflix:senha-super-secreta@db.interno:5432/prod",
  CATALOG_SYNC_TOKEN: "catalog-token-0123456789abcdef0123456789",
  WEBCINE_REFRESH_TOKEN: "webcine-refresh-0123456789",
  TMDB_API_KEY: "tmdbkey0123456789abcdef",
  PATH: "/usr/bin",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const OK_BODIES: Record<SyncJobId, unknown> = {
  megaflix: { ok: true, totalFilmes: 5, totalSeries: 2, totalEps: 36, elapsed: "50.4", log: [] },
  "tmdb-popular": {
    ok: true, found: 1000, added: 3, removed: 1, repositioned: 7, stubsCreated: 2,
    diff: { filmes: { added: ["a", "b"], removed: ["c"], repositioned: ["d", "e", "f"] }, series: { added: ["g"], removed: [], repositioned: ["h", "i", "j", "k"] } },
    stubs: { filmes: { created: 1, missing: 3 }, series: { created: 1, missing: 2 } },
  },
  webcine: { ok: true, totalFilmes: 0, totalSeries: 1, totalEps: 4, filmesAtualizados: 5, episodiosAtualizados: 6, elapsed: "22.4", log: [] },
  superflix: { ok: true, encontrados: 2354, disponiveis: 1968, seriesAdicionadas: 0, episodiosAdicionados: 1, seriesCompletadas: 2, ignorados: 1967, erros: [], duracaoMs: 5510 },
};

const IDS: SyncJobId[] = ["megaflix", "tmdb-popular", "webcine", "superflix"];

function memoryRecorder() {
  const runs: Array<{ id: string; source: string; job: string; status: string; result?: SyncRunResult; expectedNextAt?: Date | null }> = [];
  const recorder: SyncRunRecorder = {
    async start(run) { const id = `r${runs.length + 1}`; runs.push({ id, source: run.source, job: run.job, status: "RUNNING", expectedNextAt: run.expectedNextAt }); return id; },
    async finish(runId, _run, result) { const row = runs.find((r) => r.id === runId)!; row.status = result.status; row.result = result; },
  };
  return { recorder, runs };
}

async function cycle(bodies: Partial<Record<SyncJobId, (req: Request) => Promise<Response>>>, recorder?: SyncRunRecorder) {
  const mem = memoryRecorder();
  const lines: string[] = [];
  const bodiesLogged: string[] = [];
  const jobs: CycleJob[] = IDS.map((id) => ({ id, loadHandler: async () => bodies[id] ?? (async () => json(OK_BODIES[id])) }));
  let t = Date.parse("2026-09-29T12:00:00.000Z");
  const outcome = await runSyncCycle({
    jobs, cronSecret: ENV.CRON_SECRET, recorder: recorder ?? mem.recorder, env: ENV, intervalHours: 5,
    log: (line) => { lines.push(line); },
    logBody: (_job, _status, body) => { bodiesLogged.push(body); },
    now: () => new Date((t += 1000)),
  });
  return { ...outcome, runs: mem.runs, lines, bodiesLogged };
}

// ── Ciclo completo ───────────────────────────────────────────────────────────

test("ciclo local completo: 4 jobs, 4 SyncRuns *-local com contagens reais e código 0", async () => {
  const { exitCode, runs, outcomes, lines } = await cycle({});
  assert.equal(exitCode, EXIT_OK);
  assert.deepEqual(runs.map((r) => r.source), ["megaflix-local", "tmdb-popular-local", "webcine-local", "superflix-local"]);
  assert.deepEqual(runs.map((r) => r.job), ["sync", "popular-sync", "sync-webcine", "sync-superflix"]);
  assert.ok(runs.every((r) => r.status === "SUCCESS"));
  assert.ok(runs.every((r) => r.expectedNextAt instanceof Date));
  const by = Object.fromEntries(outcomes.map((o) => [o.id, o.result]));
  assert.deepEqual([by.megaflix.moviesAdded, by.megaflix.seriesAdded, by.megaflix.episodesAdded, by.megaflix.found], [5, 2, 36, null]);
  assert.deepEqual([by["tmdb-popular"].found, by["tmdb-popular"].moviesAdded, by["tmdb-popular"].moviesUpdated, by["tmdb-popular"].seriesUpdated], [1000, 1, 6, 5]);
  assert.deepEqual([by.webcine.moviesUpdated, by.webcine.episodesAdded, by.webcine.episodesUpdated], [5, 4, 6]);
  assert.deepEqual([by.superflix.found, by.superflix.episodesAdded, by.superflix.seriesUpdated], [2354, 1, 2]);
  assert.match(lines.at(-1)!, /Ciclo finalizado \(sucesso, código 0\): 4 ok/);
});

test("falha de só um job (TMDB Popular) não mascara os outros três: código 2 e SyncRun mostra qual falhou", async () => {
  const { exitCode, runs, lines } = await cycle({
    "tmdb-popular": async () => json({ ok: false, dryRun: false, error: "Duplicidade anômala em filmes: 400/500" }, 500),
  });
  assert.equal(exitCode, EXIT_PARCIAL);
  assert.deepEqual(runs.map((r) => r.status), ["SUCCESS", "FAILED", "SUCCESS", "SUCCESS"]);
  const popular = runs[1].result!;
  assert.equal(popular.errors, 1);
  assert.equal(popular.errorSummary, "Duplicidade anômala em filmes: 400/500");
  assert.match(lines.at(-1)!, /falha parcial, código 2\): 3 ok \[megaflix, webcine, superflix\], 1 falha\(s\) \[tmdb-popular\]/);
});

test("falha total: todos falham (HTTP 500, exceção e resposta não JSON) → código 1, e o ciclo segue até o fim", async () => {
  const { exitCode, runs } = await cycle({
    megaflix: async () => json({ ok: false, log: [], error: "fetch failed" }, 500),
    "tmdb-popular": async () => { throw new Error("TypeError: fetch failed"); },
    webcine: async () => new Response("<html>502</html>", { status: 502 }),
    superflix: async () => json({ ok: false, error: "fetch failed" }, 500),
  });
  assert.equal(exitCode, EXIT_TOTAL);
  assert.equal(runs.length, 4);
  assert.ok(runs.every((r) => r.status === "FAILED"));
  assert.equal(runs[2].result!.errorSummary, "HTTP 502");
});

test("job ignorado pelo lock conta como concluído (SKIPPED), não como falha", async () => {
  const { exitCode, runs } = await cycle({
    "tmdb-popular": async () => json({ ok: true, skipped: true, reason: "já existe uma sincronização em andamento" }),
  });
  assert.equal(exitCode, EXIT_OK);
  assert.equal(runs[1].status, "SKIPPED");
});

test("superflix com erros parciais reporta ok=false como falha e conta os erros", () => {
  const r = summarizeJobResult("superflix", 200, { ok: false, encontrados: 10, episodiosAdicionados: 2, erros: ["série 1: timeout", "série 2: 404"] });
  assert.equal(r.status, "FAILED");
  assert.equal(r.errors, 2);
  assert.equal(r.episodesAdded, 2);
  assert.equal(r.errorSummary, "série 1: timeout; série 2: 404");
});

test("código de saída: sem jobs 0; misto 2; todos falhos 1", () => {
  const o = (status: SyncRunResult["status"]) => ({ id: "megaflix" as const, source: "x", httpStatus: 200, durationMs: 0, result: { ...summarizeJobResult("megaflix", 200, {}), status } });
  assert.equal(exitCodeFor([]), EXIT_OK);
  assert.equal(exitCodeFor([o("SUCCESS"), o("SKIPPED")]), EXIT_OK);
  assert.equal(exitCodeFor([o("SUCCESS"), o("FAILED")]), EXIT_PARCIAL);
  assert.equal(exitCodeFor([o("FAILED"), o("FAILED")]), EXIT_TOTAL);
});

// ── Telemetria nunca derruba o ciclo ────────────────────────────────────────

test("telemetria indisponível (tabela SyncRun sem migration) não muda resultado nem código", async () => {
  const warnings: string[] = [];
  const db = {
    syncRun: {
      create: async () => { throw new Error(`relation "SyncRun" does not exist em ${ENV.DATABASE_URL}`); },
      update: async () => { throw new Error("não deveria chegar"); },
    },
  };
  const { exitCode, outcomes } = await cycle({}, createDbRecorder(db, (m) => warnings.push(m)));
  assert.equal(exitCode, EXIT_OK);
  assert.equal(outcomes.length, 4);
  assert.ok(warnings.length >= 4);
  for (const w of warnings) assert.doesNotMatch(w, /senha-super-secreta|postgresql:\/\//);
});

test("gravação no banco: RUNNING no início e atualização com contagens no fim", async () => {
  const ops: any[] = [];
  const db = {
    syncRun: {
      create: async (args: any) => { ops.push(["create", args.data]); return { id: "run-1" }; },
      update: async (args: any) => { ops.push(["update", args.where.id, args.data]); return {}; },
    },
  };
  const rec = createDbRecorder(db);
  const run = { source: "megaflix-local", job: "sync", startedAt: new Date("2026-09-29T12:00:00Z") };
  const id = await rec.start(run);
  await rec.finish(id, run, summarizeJobResult("megaflix", 200, OK_BODIES.megaflix), new Date("2026-09-29T12:01:00Z"));
  assert.equal(ops[0][1].status, "RUNNING");
  assert.equal(ops[1][1], "run-1");
  assert.equal(ops[1][2].status, "SUCCESS");
  assert.equal(ops[1][2].moviesAdded, 5);
  assert.equal(ops[1][2].found, null);
});

test("heartbeat HTTP: token só no header, runId reaproveitado, corpo sem segredos", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ ok: true, runId: "hb-1" }); }) as unknown as typeof fetch;
  const rec = createHttpRecorder({ baseUrl: "https://obaflix.example/", token: ENV.CATALOG_SYNC_TOKEN, fetchImpl });
  const run = { source: "webcine-local", job: "sync-webcine", startedAt: new Date() };
  const id = await rec.start(run);
  await rec.finish(id, run, summarizeJobResult("webcine", 500, { ok: false, error: `falhou em https://webcinevs2.com/api?token=${ENV.WEBCINE_REFRESH_TOKEN}` }), new Date());
  assert.equal(calls[0].url, "https://obaflix.example/api/integracoes/catalogo/heartbeat");
  assert.equal((calls[0].init.headers as any).authorization, `Bearer ${ENV.CATALOG_SYNC_TOKEN}`);
  const second = JSON.parse(String(calls[1].init.body));
  assert.equal(second.runId, "hb-1");
  assert.equal(second.status, "FAILED");
  for (const c of calls) {
    assert.doesNotMatch(String(c.init.body), new RegExp(`${ENV.CATALOG_SYNC_TOKEN}|${ENV.WEBCINE_REFRESH_TOKEN}|webcinevs2`));
  }
});

// ── Segredos ─────────────────────────────────────────────────────────────────

test("log, corpo gravado e SyncRun nunca contêm segredos, mesmo quando o handler os ecoa", async () => {
  const leaky = async () => json({
    ok: false,
    error: `fetch failed https://api.themoviedb.org/3/movie/popular?api_key=${ENV.TMDB_API_KEY}&page=1 com ${ENV.DATABASE_URL}`,
    debug: { cron: ENV.CRON_SECRET, auth: `Authorization: Bearer ${ENV.CATALOG_SYNC_TOKEN}` },
  }, 500);
  const { lines, bodiesLogged, runs } = await cycle({ megaflix: leaky, webcine: leaky });
  const everything = [...lines, ...bodiesLogged, ...runs.map((r) => JSON.stringify(r.result))].join("\n");
  for (const secret of [ENV.CRON_SECRET, ENV.DATABASE_URL, "senha-super-secreta", ENV.CATALOG_SYNC_TOKEN, ENV.TMDB_API_KEY]) {
    assert.ok(!everything.includes(secret), `vazou: ${secret.slice(0, 12)}…`);
  }
  assert.doesNotMatch(runs[0].result!.errorSummary!, /https?:\/\//, "painel não recebe URL");
});

test("redactSecrets cobre variáveis sensíveis, query e credencial em URL", () => {
  const out = redactSecrets(`a ${ENV.WEBCINE_REFRESH_TOKEN} b access_token=xyz c postgres://u:p@h/db d Authorization: Bearer abc.def`, ENV);
  assert.doesNotMatch(out, /webcine-refresh|xyz|u:p@|abc\.def/);
  assert.match(out, /PATH|a \[removido\]/);
});

// ── Vercel ───────────────────────────────────────────────────────────────────

test("withCronTelemetry grava <job>-vercel, mas não no runner local nem em 401", async () => {
  const finished: string[] = [];
  const recorder: SyncRunRecorder = { start: async () => null, finish: async (_id, run, result) => { finished.push(`${run.source}:${result.status}`); } };
  const wrapped = withCronTelemetry("megaflix", async (req: Request) =>
    req.headers.get("authorization") === "Bearer ok" ? json(OK_BODIES.megaflix) : json({ error: "Não autorizado" }, 401), async () => recorder);
  const before = process.env.LOCAL_SYNC_RUNNER;
  try {
    delete process.env.LOCAL_SYNC_RUNNER;
    assert.equal((await wrapped(new Request("http://x/api/cron/sync", { headers: { authorization: "Bearer ok" } }))).status, 200);
    assert.equal((await wrapped(new Request("http://x/api/cron/sync"))).status, 401);
    process.env.LOCAL_SYNC_RUNNER = "1";
    await wrapped(new Request("http://x/api/cron/sync", { headers: { authorization: "Bearer ok" } }));
  } finally {
    if (before === undefined) delete process.env.LOCAL_SYNC_RUNNER; else process.env.LOCAL_SYNC_RUNNER = before;
  }
  assert.deepEqual(finished, ["megaflix-vercel:SUCCESS"]);
});

test("os 4 handlers de cron exportam GET envolvido por withCronTelemetry", async () => {
  const { readFileSync } = await import("node:fs");
  const rotas: Record<string, SyncJobId> = { sync: "megaflix", "popular-sync": "tmdb-popular", "sync-webcine": "webcine", "sync-superflix": "superflix" };
  for (const [rota, id] of Object.entries(rotas)) {
    const src = readFileSync(`src/app/api/cron/${rota}/route.ts`, "utf8");
    assert.match(src, new RegExp(`export const GET = withCronTelemetry\\("${id}", handleGET\\);`), rota);
    assert.doesNotMatch(src, /export async function GET/, rota);
  }
});
