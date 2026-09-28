import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planEpisodeWrites, writeEpisodesByCoordinate, type ExistingEpisode } from "../episode-coordinate";
import { planGroup, rankCandidates, runEpisodeDedupe, type DedupeEpisode, type DedupeWatch } from "../episode-dedupe";
import { assertBackupDirOutsideGit, parseDedupeArgs } from "../../../scripts/dedupe-episodios";

const T0 = new Date("2026-01-01T00:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const ep = (id: string, o: Partial<DedupeEpisode> = {}): DedupeEpisode => ({
  id, serieId: "s1", temporada: 1, numeroEp: 3, titulo: null, thumbnail: null, urlDub: null, urlLeg: null, createdAt: T0, ...o,
});
const wh = (id: string, episodioId: string, o: Partial<DedupeWatch> = {}): DedupeWatch => ({
  id, userId: "u1", conteudoId: "s1", episodioId, progressoSeg: 10, concluido: false, updatedAt: T0, ...o,
});

// ── Escrita pela coordenada (produtores em lote) ────────────────────────────

test("coordenada existente com outro ID (WebCine × SuperFlix) nunca vira INSERT; só completa campos vazios", () => {
  const existing: ExistingEpisode[] = [{ id: "wc_ep_560647", serieId: "s1", temporada: 1, numeroEp: 3, titulo: null, thumbnail: null, urlDub: "https://wc/x", urlLeg: null }];
  const plan = planEpisodeWrites(existing, [
    { id: "sf_1-t1e3", serieId: "s1", temporada: 1, numeroEp: 3, titulo: "Três", urlDub: "https://sf/x", thumbnail: "" },
    { id: "sf_1-t1e4", serieId: "s1", temporada: 1, numeroEp: 4, urlDub: "https://sf/y" },
  ]);
  assert.deepEqual(plan.create.map((r) => r.id), ["sf_1-t1e4"]);
  assert.deepEqual(plan.fill, [{ id: "wc_ep_560647", data: { titulo: "Três" } }], "urlDub válido não é trocado; vazio não sobrescreve");
  assert.equal(plan.skipped, 1);
});

test("mesma coordenada repetida no lote vira uma linha só, com campos complementares", () => {
  const plan = planEpisodeWrites([], [
    { id: "a", serieId: "s", temporada: 1, numeroEp: 1, urlDub: "d" },
    { id: "b", serieId: "s", temporada: 1, numeroEp: 1, urlLeg: "l", titulo: "T" },
  ]);
  assert.equal(plan.create.length, 1);
  assert.deepEqual([plan.create[0].id, plan.create[0].urlDub, plan.create[0].urlLeg, plan.create[0].titulo], ["a", "d", "l", "T"]);
});

test("writeEpisodesByCoordinate: consulta pela coordenada, ordem determinística, idempotente em reexecução", async () => {
  const rows: any[] = [{ id: "wc_ep_1", serieId: "s", temporada: 1, numeroEp: 1, titulo: null, thumbnail: null, urlDub: "u", urlLeg: null, createdAt: T0 }];
  const queries: any[] = [];
  const db = { episodio: {
    findMany: async (args: any) => {
      queries.push(args);
      return rows.filter((r) => args.where.OR.some((c: any) => c.serieId === r.serieId && c.temporada === r.temporada && c.numeroEp === r.numeroEp));
    },
    update: async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data),
    createMany: async ({ data }: any) => { for (const d of data) rows.push({ titulo: null, thumbnail: null, urlDub: null, urlLeg: null, ...d }); return { count: data.length }; },
  } };
  const lote = [
    { id: "sf-t1e1", serieId: "s", temporada: 1, numeroEp: 1, thumbnail: "th" },
    { id: "sf-t1e2", serieId: "s", temporada: 1, numeroEp: 2 },
  ];
  assert.deepEqual(await writeEpisodesByCoordinate(db, lote), { created: 1, filled: 1, skipped: 1 });
  assert.deepEqual(await writeEpisodesByCoordinate(db, lote), { created: 0, filled: 0, skipped: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].thumbnail, "th");
  assert.deepEqual(queries[0].orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
});

test("nenhum produtor em lote grava episódio só com createMany cru", () => {
  for (const f of ["src/lib/superflix-calendar.ts", "scripts/sync-webcine.ts", "scripts/import.ts", "scripts/sync-megaflix.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /prisma\.episodio\.createMany/, f);
    assert.match(src, /writeEpisodesByCoordinate\(prisma/, f);
  }
  const mjs = readFileSync("scripts/import-episodes.mjs", "utf8");
  assert.match(mjs, /ocupadas\.has\(k\)/);
  const webcineCron = readFileSync("src/lib/cron/webcine.ts", "utf8");
  assert.match(webcineCron, /porCoordenada/);
  assert.match(webcineCron, /pendentes\.has\(key\)/);
  const megaflixCron = readFileSync("src/app/api/cron/sync/route.ts", "utf8");
  assert.match(megaflixCron, /findFirst\(\{\s*where: \{ serieId: item\.id!, temporada: e\.temp, numeroEp: e\.ep \}/);
});

// ── Canônico ────────────────────────────────────────────────────────────────

test("canônico: 1) referenciado por WatchHistory vence metadata", () => {
  const g = [ep("rico", { urlDub: "a", urlLeg: "b", titulo: "T", thumbnail: "t" }), ep("visto")];
  assert.equal(rankCandidates(g, new Map([["visto", 1]]))[0].id, "visto");
});

test("canônico: 2) mais metadata válida; título placeholder não conta", () => {
  const g = [ep("a", { titulo: "Episódio 3", urlDub: "x" }), ep("b", { titulo: "Nome real", urlDub: "x" })];
  assert.equal(rankCandidates(g, new Map())[0].id, "b");
});

test("canônico: 3) ID no padrão atual, 4) createdAt, 5) id", () => {
  assert.equal(rankCandidates([ep("wc_ep_9"), ep("s1-t1e3")], new Map())[0].id, "s1-t1e3");
  assert.equal(rankCandidates([ep("x", { createdAt: at(5) }), ep("y", { createdAt: at(1) })], new Map())[0].id, "y");
  assert.equal(rankCandidates([ep("z"), ep("m")], new Map())[0].id, "m");
  // determinístico: a ordem de entrada não muda o resultado
  assert.equal(rankCandidates([ep("m"), ep("z")], new Map())[0].id, "m");
});

// ── Merge de metadata e FKs ─────────────────────────────────────────────────

test("merge: completa vazios, troca placeholder por título real, soma espelhos e nunca apaga válido", () => {
  const plan = planGroup([
    ep("s1-t1e3", { titulo: "Episódio 3", urlDub: "https://a/1", urlLeg: null }),
    ep("wc_ep_560647", { titulo: "O Retorno", thumbnail: "th", urlDub: "https://wc/1,https://a/1", urlLeg: "https://leg/1", createdAt: at(10) }),
  ], []);
  assert.equal(plan.canonicalId, "wc_ep_560647", "mais metadata válida");
  assert.deepEqual(plan.removeIds, ["s1-t1e3"]);
  assert.deepEqual(plan.merge, {}, "canônico já tinha tudo e contém os espelhos do outro");

  const p2 = planGroup([
    ep("s1-t1e3", { urlDub: "https://a/1", thumbnail: "th1", titulo: "Episódio 3" }),
    ep("sf_1", { urlDub: "https://sf/1", urlLeg: "https://leg", titulo: "Nome", thumbnail: "th2", createdAt: at(1) }),
  ], [wh("w1", "s1-t1e3")]);
  assert.equal(p2.canonicalId, "s1-t1e3", "referenciado vence");
  assert.deepEqual(p2.merge, { titulo: "Nome", urlDub: "https://a/1,https://sf/1", urlLeg: "https://leg" });
  assert.equal(p2.conflicts.length, 1, "thumbnail divergente registrada, canônica mantida");
});

test("FK: WatchHistory da duplicata migra; colisão do mesmo usuário mantém o mais recente e herda concluído", () => {
  const plan = planGroup([ep("s1-t1e3"), ep("dup", { createdAt: at(1) })], [
    wh("w-can", "s1-t1e3", { updatedAt: at(1), concluido: true }),
    wh("w-dup", "dup", { updatedAt: at(9), progressoSeg: 300 }),
    wh("w-outro", "dup", { userId: "u2" }),
  ]);
  assert.equal(plan.canonicalId, "dup", "mais referências");
  assert.deepEqual(plan.watchDrop.sort(), ["w-can"]);
  assert.deepEqual(plan.watchMove.sort(), []);
  assert.deepEqual(plan.watchMarkDone, ["w-dup"]);

  const p2 = planGroup([ep("s1-t1e3", { urlDub: "x" }), ep("dup", { createdAt: at(1) })], [wh("w1", "dup")]);
  assert.equal(p2.canonicalId, "dup");
  const p3 = planGroup([ep("s1-t1e3"), ep("dup", { createdAt: at(1) })], [wh("w1", "s1-t1e3"), wh("w2", "dup", { userId: "u2" })]);
  assert.equal(p3.canonicalId, "s1-t1e3", "empate de referências → metadata/ID padrão");
  assert.deepEqual(p3.watchMove, ["w2"]);
});

// ── Execução: banco em memória com transação real (snapshot/rollback) ───────

function memoryDb(episodes: DedupeEpisode[], watch: DedupeWatch[], opts: { breakInvariantOn?: string } = {}) {
  let state = { eps: episodes.map((e) => ({ ...e })), wh: watch.map((w) => ({ ...w })) };
  const writes: string[] = [];
  const inIds = (w: any, field: string, row: any) => w[field]?.in ? w[field].in.includes(row[field]) : true;
  const matchEp = (w: any, r: any) => (w.id?.in ? w.id.in.includes(r.id) : true)
    && (w.serieId === undefined || w.serieId === r.serieId) && (w.temporada === undefined || w.temporada === r.temporada) && (w.numeroEp === undefined || w.numeroEp === r.numeroEp);
  const sort = (rows: any[]) => rows.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const db: any = {
    episodio: {
      findMany: async ({ where }: any) => sort(state.eps.filter((r) => matchEp(where, r)).map((r) => ({ ...r }))),
      update: async ({ where, data }: any) => {
        writes.push(`ep.update:${where.id}`);
        if (opts.breakInvariantOn === where.id) data = { ...data, urlDub: null };
        Object.assign(state.eps.find((r) => r.id === where.id)!, data);
      },
      deleteMany: async ({ where }: any) => {
        writes.push("ep.delete");
        if (state.wh.some((w) => w.episodioId && where.id.in.includes(w.episodioId))) throw new Error("FK violada");
        const before = state.eps.length;
        state.eps = state.eps.filter((r) => !where.id.in.includes(r.id));
        return { count: before - state.eps.length };
      },
    },
    watchHistory: {
      findMany: async ({ where }: any) => state.wh.filter((r) => inIds(where, "episodioId", r)).map((r) => ({ ...r })),
      update: async ({ where, data }: any) => {
        writes.push(`wh.update:${where.id}`);
        const row = state.wh.find((r) => r.id === where.id)!;
        const next = { ...row, ...data };
        if (state.wh.some((r) => r.id !== row.id && r.userId === next.userId && r.conteudoId === next.conteudoId && r.episodioId === next.episodioId)) {
          throw new Error("unique WatchHistory");
        }
        Object.assign(row, data);
      },
      deleteMany: async ({ where }: any) => {
        writes.push("wh.delete");
        const before = state.wh.length;
        state.wh = state.wh.filter((r) => !where.id.in.includes(r.id));
        return { count: before - state.wh.length };
      },
      count: async ({ where }: any) => state.wh.filter((r) => inIds(where, "episodioId", r)).length,
    },
    $transaction: async (fn: any) => {
      const snapshot = structuredClone(state);
      try { return await fn(db); } catch (e) { state = snapshot; throw e; }
    },
  };
  const listDuplicates = async () => {
    const counts = new Map<string, any>();
    for (const e of state.eps) {
      const k = `${e.serieId}|${e.temporada}|${e.numeroEp}`;
      counts.set(k, { c: (counts.get(k)?.c ?? 0) + 1, coord: { serieId: e.serieId, temporada: e.temporada, numeroEp: e.numeroEp } });
    }
    return [...counts.values()].filter((v) => v.c > 1).map((v) => v.coord);
  };
  return { db, writes, listDuplicates, get state() { return state; } };
}

const fixture = () => [
  [
    ep("s1-t1e3", { titulo: "Episódio 3", urlDub: "https://a/1" }),
    ep("wc_ep_560647", { titulo: "Real", urlLeg: "https://leg/1", createdAt: at(3) }),
    ep("sf_x", { thumbnail: "th", createdAt: at(4) }),
    ep("s1-t1e4", { numeroEp: 4, urlDub: "único" }),
    ep("s2-t1e1", { serieId: "s2", numeroEp: 1 }),
    ep("wc_ep_2", { serieId: "s2", numeroEp: 1, createdAt: at(1) }),
  ],
  [
    wh("w1", "wc_ep_560647", { updatedAt: at(5) }),
    wh("w2", "s1-t1e3", { updatedAt: at(1), concluido: true }),
    wh("w3", "sf_x", { userId: "u9" }),
  ],
] as const;

test("dry-run (padrão): relatório completo e ZERO escrita", async () => {
  const [eps, whs] = fixture();
  const m = memoryDb([...eps], [...whs]);
  const r = await runEpisodeDedupe(m.db, { mode: "dry-run", listDuplicates: m.listDuplicates });
  assert.deepEqual(
    { grupos: r.grupos, linhas: r.linhas, canonicos: r.canonicos, removiveis: r.removiveis, erros: r.erros.length, aplicados: r.aplicados },
    { grupos: 2, linhas: 5, canonicos: 2, removiveis: 3, erros: 0, aplicados: 0 },
  );
  assert.ok(r.fksMover >= 1 && r.watchMesclar === 1 && r.camposMesclar >= 2);
  assert.deepEqual(m.writes, [], "dry-run não escreve");
  assert.equal(m.state.eps.length, 6);
  assert.equal(r.backupFile, null);
});

test("apply sem backup é recusado antes de ler ou escrever qualquer coisa", async () => {
  const [eps, whs] = fixture();
  const m = memoryDb([...eps], [...whs]);
  let listed = false;
  await assert.rejects(runEpisodeDedupe(m.db, { mode: "apply", listDuplicates: async () => { listed = true; return []; } }), /backup/);
  assert.equal(listed, false);
  assert.deepEqual(m.writes, []);
});

test("apply: backup gravado ANTES da primeira escrita; resultado com uma linha por coordenada e FKs íntegras", async () => {
  const [eps, whs] = fixture();
  const m = memoryDb([...eps], [...whs]);
  let writesAtBackup = -1;
  let backup: any;
  const r = await runEpisodeDedupe(m.db, {
    mode: "apply",
    listDuplicates: m.listDuplicates,
    writeBackup: async (payload) => { writesAtBackup = m.writes.length; backup = payload; return "/tmp/fake.json"; },
  });
  assert.equal(writesAtBackup, 0);
  assert.equal(backup.grupos.length, 2);
  assert.equal(backup.grupos[0].episodios.length + backup.grupos[1].episodios.length, 5);
  assert.deepEqual([r.aplicados, r.erros.length, r.backupFile], [2, 0, "/tmp/fake.json"]);

  const s1 = m.state.eps.filter((e) => e.serieId === "s1" && e.numeroEp === 3);
  assert.equal(s1.length, 1);
  assert.equal(s1[0].id, "wc_ep_560647", "referenciado mais recente/metadata");
  assert.deepEqual([s1[0].titulo, s1[0].urlDub, s1[0].urlLeg, s1[0].thumbnail], ["Real", "https://a/1", "https://leg/1", "th"]);
  assert.equal(m.state.eps.filter((e) => e.serieId === "s2").length, 1);
  assert.equal(m.state.eps.find((e) => e.id === "s1-t1e4")?.urlDub, "único", "fora de grupo não é tocado");

  const ids = new Set(m.state.eps.map((e) => e.id));
  assert.ok(m.state.wh.every((w) => ids.has(w.episodioId!)), "nenhum WatchHistory órfão");
  const u1 = m.state.wh.filter((w) => w.userId === "u1");
  assert.equal(u1.length, 1, "colisão do mesmo usuário resolvida");
  assert.deepEqual([u1[0].id, u1[0].concluido], ["w1", true], "fica o mais recente e herda concluído");
  assert.equal(m.state.wh.find((w) => w.id === "w3")?.episodioId, "wc_ep_560647", "FK movida");

  const again = await runEpisodeDedupe(m.db, { mode: "dry-run", listDuplicates: m.listDuplicates });
  assert.equal(again.grupos, 0, "reexecução não encontra mais nada");
});

test("apply: invariante quebrada desfaz o grupo inteiro e aborta os seguintes", async () => {
  const [eps, whs] = fixture();
  const m = memoryDb([...eps], [...whs], { breakInvariantOn: "wc_ep_560647" });
  const before = structuredClone(m.state);
  const r = await runEpisodeDedupe(m.db, { mode: "apply", listDuplicates: m.listDuplicates, writeBackup: async () => "/tmp/b.json" });
  assert.equal(r.aplicados, 0);
  assert.equal(r.erros.length, 1);
  assert.match(r.erros[0], /abortado/);
  assert.deepEqual(m.state, before, "rollback: nada mudou em nenhum grupo");
});

test("apply: grupo alterado entre planejamento e execução não é tocado", async () => {
  const [eps, whs] = fixture();
  const m = memoryDb([...eps], [...whs]);
  const r = await runEpisodeDedupe(m.db, {
    mode: "apply",
    listDuplicates: m.listDuplicates,
    writeBackup: async () => { m.state.eps.push(ep("novo", { createdAt: at(99) })); return "/tmp/b.json"; },
  });
  assert.equal(r.aplicados, 0);
  assert.match(r.erros[0], /grupo mudou/);
});

// ── CLI ─────────────────────────────────────────────────────────────────────

test("CLI: dry-run é o padrão; --apply exige --backup-dir; flags conflitantes são erro", () => {
  assert.deepEqual(parseDedupeArgs([]), { mode: "dry-run", backupDir: undefined });
  assert.deepEqual(parseDedupeArgs(["--dry-run"]), { mode: "dry-run", backupDir: undefined });
  assert.throws(() => parseDedupeArgs(["--apply"]), /--backup-dir/);
  assert.throws(() => parseDedupeArgs(["--apply", "--backup-dir"]), /caminho/);
  assert.throws(() => parseDedupeArgs(["--apply", "--dry-run", "--backup-dir", "/x"]), /não os dois/);
  assert.deepEqual(parseDedupeArgs(["--apply", "--backup-dir", "/b"]), { mode: "apply", backupDir: "/b" });
});

test("CLI: backup nunca em pasta versionada (só backups/, que o .gitignore exclui)", () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  assert.throws(() => assertBackupDirOutsideGit(join(repo, "scripts"), repo), /backups/);
  assert.throws(() => assertBackupDirOutsideGit(repo, repo), /backups/);
  assert.equal(assertBackupDirOutsideGit(join(repo, "backups", "x"), repo), join(repo, "backups", "x"));
  assert.equal(assertBackupDirOutsideGit(join(tmpdir(), "fora"), repo), join(tmpdir(), "fora"));
  assert.match(readFileSync(".gitignore", "utf8"), /^\/backups\/$/m);
  assert.deepEqual(readdirSync(repo), []);
});

// ── Migration do índice único ───────────────────────────────────────────────

const DIR = "prisma/migrations/20260930120000_episodio_unique_coordenada";
const semComentario = (sql: string) => sql.replace(/--.*$/gm, "");

test("migration: transação, falha com duplicata, índice único idempotente com o nome do Prisma, nada destrutivo", () => {
  const sql = semComentario(readFileSync(`${DIR}/migration.sql`, "utf8"));
  assert.match(sql, /^\s*BEGIN;/m);
  assert.match(sql, /^\s*COMMIT;\s*$/m);
  assert.match(sql, /SET LOCAL lock_timeout/);
  assert.match(sql, /HAVING count\(\*\) > 1/);
  assert.match(sql, /RAISE EXCEPTION/);
  assert.ok(sql.indexOf("RAISE EXCEPTION") < sql.indexOf("CREATE UNIQUE INDEX"), "checa antes de criar");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "Episodio_serieId_temporada_numeroEp_key"\s+ON "Episodio" \("serieId", "temporada", "numeroEp"\);/);
  assert.doesNotMatch(sql, /\b(DELETE|DROP|TRUNCATE|UPDATE|INSERT|ALTER)\b/i);
  assert.doesNotMatch(sql, /CONCURRENTLY/, "não roda dentro de transação");
});

test("migration: VERIFICACAO somente leitura cobre zero duplicatas e índice válido; ROLLBACK só derruba o índice", () => {
  const ver = readFileSync(`${DIR}/VERIFICACAO.sql`, "utf8");
  assert.match(ver, /A1 zero duplicatas/);
  assert.match(ver, /B1 indice unico valido/);
  assert.match(ver, /indisunique AND i\.indisvalid/);
  assert.doesNotMatch(semComentario(ver), /\b(DELETE|DROP|TRUNCATE|UPDATE|INSERT|ALTER|CREATE)\b/i);
  const rb = semComentario(readFileSync(`${DIR}/ROLLBACK.sql`, "utf8"));
  assert.match(rb, /DROP INDEX IF EXISTS "Episodio_serieId_temporada_numeroEp_key";/);
  assert.doesNotMatch(rb, /DELETE|TRUNCATE|DROP TABLE/i);
});

test("schema declara o mesmo @@unique e nada roda prisma db push", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema.slice(schema.indexOf("model Episodio")), /@@unique\(\[serieId, temporada, numeroEp\]\)/);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.doesNotMatch(pkg.scripts.build, /db push|migrate/);
});
