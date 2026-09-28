import { sanitizeErrorSummary } from "@/lib/sync-sources";

/**
 * Telemetria dos jobs de catálogo (SyncRun).
 *
 * Os mesmos route handlers rodam em dois lugares: na tarefa Windows de 5h
 * (em processo, via scripts/run-local-syncs.ts) e no Vercel Cron. A origem
 * entra no `source` (`<job>-local` / `<job>-vercel`) para o painel separar os
 * dois. Registrar telemetria é sempre "melhor esforço": falhar ao gravar
 * SyncRun (tabela ainda sem migration, banco fora) nunca muda o resultado do
 * job nem o código de saída do ciclo.
 */

export type SyncJobId = "megaflix" | "tmdb-popular" | "webcine" | "superflix";
export type SyncOrigin = "local" | "vercel";
export type SyncStatus = "RUNNING" | "SUCCESS" | "FAILED" | "SKIPPED";

/** Rota do handler e nome do job gravado em SyncRun.job. */
export const SYNC_JOBS: Record<SyncJobId, { path: string; job: string }> = {
  megaflix: { path: "/api/cron/sync", job: "sync" },
  "tmdb-popular": { path: "/api/cron/popular-sync", job: "popular-sync" },
  webcine: { path: "/api/cron/sync-webcine", job: "sync-webcine" },
  superflix: { path: "/api/cron/sync-superflix", job: "sync-superflix" },
};

export const syncSource = (id: SyncJobId, origin: SyncOrigin) => `${id}-${origin}`;

export type SyncCounts = {
  found: number | null;
  moviesAdded: number;
  moviesUpdated: number;
  seriesAdded: number;
  seriesUpdated: number;
  episodesAdded: number;
  episodesUpdated: number;
  errors: number;
};

export type SyncRunResult = SyncCounts & {
  status: Exclude<SyncStatus, "RUNNING">;
  errorSummary: string | null;
};

const n = (value: unknown) => {
  const v = Math.floor(Number(value));
  return Number.isFinite(v) && v > 0 ? v : 0;
};
const len = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const obj = (value: unknown): Record<string, any> => (value && typeof value === "object" ? (value as Record<string, any>) : {});

const ZERO: SyncCounts = { found: null, moviesAdded: 0, moviesUpdated: 0, seriesAdded: 0, seriesUpdated: 0, episodesAdded: 0, episodesUpdated: 0, errors: 0 };

/**
 * Converte a resposta de cada handler em contagens. Só usa campos que o
 * handler realmente devolve: o que ele não informa fica 0 (ou `found: null`),
 * nunca estimado.
 */
export function summarizeJobResult(id: SyncJobId, httpStatus: number, body: unknown, thrown?: unknown): SyncRunResult {
  if (thrown !== undefined) {
    return { ...ZERO, errors: 1, status: "FAILED", errorSummary: sanitizeErrorSummary(thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)) };
  }
  const b = obj(body);
  const failed = httpStatus < 200 || httpStatus >= 300 || b.ok === false;
  const skipped = !failed && b.skipped === true;
  let counts: SyncCounts = { ...ZERO };

  if (id === "megaflix") {
    // totalFilmes/Series/Eps são itens NOVOS (inclui o WebCine embutido no sync).
    counts = { ...ZERO, moviesAdded: n(b.totalFilmes), seriesAdded: n(b.totalSeries), episodesAdded: n(b.totalEps) };
  } else if (id === "webcine") {
    counts = {
      ...ZERO,
      moviesAdded: n(b.totalFilmes), seriesAdded: n(b.totalSeries), episodesAdded: n(b.totalEps),
      moviesUpdated: n(b.filmesAtualizados), episodesUpdated: n(b.episodiosAtualizados),
    };
  } else if (id === "tmdb-popular") {
    // Ranking: "adicionado" = stub criado; "atualizado" = posição que mudou.
    const diff = obj(b.diff);
    const rankChanges = (d: unknown) => len(obj(d).added) + len(obj(d).removed) + len(obj(d).repositioned);
    counts = {
      ...ZERO,
      found: b.found === undefined ? null : n(b.found),
      moviesAdded: n(obj(obj(b.stubs).filmes).created),
      seriesAdded: n(obj(obj(b.stubs).series).created),
      moviesUpdated: rankChanges(diff.filmes),
      seriesUpdated: rankChanges(diff.series),
    };
  } else if (id === "superflix") {
    counts = {
      ...ZERO,
      found: b.encontrados === undefined ? null : n(b.encontrados),
      seriesAdded: n(b.seriesAdicionadas),
      seriesUpdated: n(b.seriesCompletadas),
      episodesAdded: n(b.episodiosAdicionados),
      errors: len(b.erros),
    };
  }

  const rawError = typeof b.error === "string" ? b.error
    : Array.isArray(b.erros) && b.erros.length ? b.erros.slice(0, 5).join("; ")
    : failed ? `HTTP ${httpStatus}` : null;
  if (skipped) return { ...counts, status: "SKIPPED", errorSummary: sanitizeErrorSummary(typeof b.reason === "string" ? b.reason : "ignorado") };
  return {
    ...counts,
    errors: failed ? Math.max(1, counts.errors) : counts.errors,
    status: failed ? "FAILED" : "SUCCESS",
    errorSummary: sanitizeErrorSummary(rawError),
  };
}

const SENSITIVE_ENV = /(SECRET|TOKEN|PASSWORD|SENHA|KEY|DATABASE_URL|DIRECT_URL|COOKIE|JWT|AUTH|CREDENTIAL|DEVICE_ID|PROFILE_ID)/i;

/**
 * Remove de um texto (log, corpo de resposta) valores de variáveis sensíveis
 * do ambiente e segredos de query. URLs comuns do log continuam legíveis;
 * a exibição no painel passa ainda por `sanitizeErrorSummary`.
 */
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  const values = Object.entries(env)
    .filter(([name, value]) => SENSITIVE_ENV.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("[removido]");
  return out
    .replace(/\b(api_key|access_token|refresh_token|token|secret|senha|password)=([^\s&"']+)/gi, "$1=[removido]")
    .replace(/(authorization["']?\s*[:=]\s*["']?Bearer\s+)[^\s"']+/gi, "$1[removido]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/"']+:[^\s@/"']+@/gi, "$1[removido]@");
}

// ── Gravação ─────────────────────────────────────────────────────────────────

export type SyncRunStart = { source: string; job: string; startedAt: Date; expectedNextAt?: Date | null };

export interface SyncRunRecorder {
  /** Devolve o id da execução, ou null se não foi possível registrar. */
  start(run: SyncRunStart): Promise<string | null>;
  finish(runId: string | null, run: SyncRunStart, result: SyncRunResult, finishedAt: Date): Promise<void>;
}

type SyncRunDb = {
  syncRun: {
    create(args: { data: Record<string, unknown>; select?: { id: true } }): Promise<{ id: string }>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
};

const resultData = (result: SyncRunResult, finishedAt: Date) => ({
  status: result.status,
  finishedAt,
  heartbeatAt: finishedAt,
  found: result.found,
  moviesAdded: result.moviesAdded, moviesUpdated: result.moviesUpdated,
  seriesAdded: result.seriesAdded, seriesUpdated: result.seriesUpdated,
  episodesAdded: result.episodesAdded, episodesUpdated: result.episodesUpdated,
  errors: result.errors,
  errorSummary: sanitizeErrorSummary(result.errorSummary),
});

/** Grava direto no banco (o job local já tem DATABASE_URL). */
export function createDbRecorder(db: SyncRunDb, onError: (message: string) => void = () => {}): SyncRunRecorder {
  const fail = (step: string, error: unknown) =>
    onError(`telemetria indisponível (${step}): ${sanitizeErrorSummary(error instanceof Error ? error.message : String(error)) ?? "erro"}`);
  return {
    async start(run) {
      try {
        const row = await db.syncRun.create({
          data: { source: run.source, job: run.job, status: "RUNNING", startedAt: run.startedAt, heartbeatAt: run.startedAt, expectedNextAt: run.expectedNextAt ?? null },
          select: { id: true },
        });
        return row.id;
      } catch (error) { fail("início", error); return null; }
    },
    async finish(runId, run, result, finishedAt) {
      try {
        if (runId) await db.syncRun.update({ where: { id: runId }, data: resultData(result, finishedAt) });
        else await db.syncRun.create({ data: { source: run.source, job: run.job, startedAt: run.startedAt, expectedNextAt: run.expectedNextAt ?? null, ...resultData(result, finishedAt) } });
      } catch (error) { fail("fim", error); }
    },
  };
}

/**
 * Grava via `POST /api/integracoes/catalogo/heartbeat` com CATALOG_SYNC_TOKEN.
 * Para produtores sem acesso ao banco. O token vai só no header.
 */
export function createHttpRecorder(opts: { baseUrl: string; token: string; fetchImpl?: typeof fetch; onError?: (message: string) => void }): SyncRunRecorder {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/integracoes/catalogo/heartbeat`;
  const post = async (body: Record<string, unknown>) => {
    const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`heartbeat HTTP ${res.status}`);
    return (await res.json().catch(() => ({}))) as { runId?: string };
  };
  const fail = (error: unknown) => opts.onError?.(`telemetria indisponível: ${sanitizeErrorSummary(error instanceof Error ? error.message : String(error)) ?? "erro"}`);
  return {
    async start(run) {
      try {
        return (await post({ source: run.source, job: run.job, status: "RUNNING", expectedNextAt: run.expectedNextAt?.toISOString() })).runId ?? null;
      } catch (error) { fail(error); return null; }
    },
    async finish(runId, run, result) {
      try {
        await post({ ...(runId ? { runId } : {}), source: run.source, job: run.job, ...result, errorSummary: sanitizeErrorSummary(result.errorSummary), expectedNextAt: run.expectedNextAt?.toISOString() });
      } catch (error) { fail(error); }
    },
  };
}

// ── Vercel Cron ──────────────────────────────────────────────────────────────

type RouteHandler<R extends Request> = (req: R) => Promise<Response>;

/**
 * Envolve um handler de cron para registrar SyncRun `<job>-vercel`.
 * Não registra quando o chamador é o runner local (LOCAL_SYNC_RUNNER=1, que
 * grava `<job>-local` ele mesmo) nem requisição não autorizada (401), para
 * que ninguém consiga poluir a telemetria sem o CRON_SECRET.
 */
export function withCronTelemetry<R extends Request>(
  id: SyncJobId,
  handler: RouteHandler<R>,
  getRecorder: () => Promise<SyncRunRecorder> = defaultRecorder,
): RouteHandler<R> {
  return async (req: R) => {
    if (process.env.LOCAL_SYNC_RUNNER === "1") return handler(req);
    const startedAt = new Date();
    const run = { source: syncSource(id, "vercel"), job: SYNC_JOBS[id].job, startedAt };
    let response: Response;
    try {
      response = await handler(req);
    } catch (error) {
      await (await getRecorder()).finish(null, run, summarizeJobResult(id, 500, null, error), new Date());
      throw error;
    }
    if (response.status === 401) return response;
    const body = await response.clone().json().catch(() => null);
    await (await getRecorder()).finish(null, run, summarizeJobResult(id, response.status, body), new Date());
    return response;
  };
}

async function defaultRecorder(): Promise<SyncRunRecorder> {
  const { prisma } = await import("@/lib/prisma");
  return createDbRecorder(prisma as unknown as SyncRunDb, (message) => console.warn(`[sync] ${message}`));
}
