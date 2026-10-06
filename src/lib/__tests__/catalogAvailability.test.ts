import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { FILME_REPRODUZIVEL, SERIE_REPRODUZIVEL, FILME_STUB_SEM_PLAYER, SERIE_STUB_SEM_PLAYER, filmeDisponivel, serieDisponivel } from "../catalog-availability";
import { cleanupCatalogStubs } from "../catalog-stub-cleanup";

// Avalia apenas os operadores Prisma usados nestas regras; fixtures, sem banco.
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: [string, any]) => {
    if (key === "AND") return value.every((v: any) => matches(row, v));
    if (key === "OR") return value.some((v: any) => matches(row, v));
    if (key === "NOT") return !matches(row, value);
    if (value === null || typeof value !== "object") return row[key] === value;
    if ("some" in value) return row[key].some((v: any) => matches(v, value.some));
    if ("not" in value) return row[key] !== value.not;
    if ("startsWith" in value) return row[key].startsWith(value.startsWith);
    if ("in" in value) return value.in.includes(row[key]);
    throw Error("Operador não coberto pela fixture");
  });
}

test("filme exige dub OU leg; série exige episódio com dub OU leg", () => {
  for (const [dub, leg, expected] of [[null, null, false], ["dub", null, true], [null, "leg", true], ["dub", "leg", true]]) {
    const media = { urlDub: dub, urlLeg: leg };
    assert.equal(matches(media, FILME_REPRODUZIVEL), expected);
    assert.equal(matches({ episodios: [media] }, SERIE_REPRODUZIVEL), expected);
  }
  assert.equal(matches({ episodios: [] }, SERIE_REPRODUZIVEL), false);
  assert.equal(matches({ episodios: [{ urlDub: null, urlLeg: null }, { urlDub: "real", urlLeg: null }] }, SERIE_REPRODUZIVEL), true);
});

test("filtros adicionais com OR não substituem disponibilidade; limite e count são posteriores", () => {
  const rows = [{ id: "stub", urlDub: null, urlLeg: null, rank: 1 }, { id: "real", urlDub: "url", urlLeg: null, rank: 2 }];
  const where = filmeDisponivel({ OR: [{ id: "stub" }, { id: "real" }] });
  const elegiveis = rows.filter(r => matches(r, where));
  assert.deepEqual(elegiveis.slice(0, 1).map(r => r.id), ["real"]);
  assert.equal(elegiveis.length, 1);
  assert.equal(matches({ episodios: [], tipo: "serie" }, serieDisponivel({ tipo: "serie" })), false);
});

const surfaces = ["src/components/home/HomeStreaming.tsx", "src/app/api/tv/home/route.ts", "src/app/android/page.tsx", "src/app/api/home/route.ts", "src/app/series/page.tsx", "src/app/api/series/route.ts", "src/app/filmes/page.tsx", "src/app/api/filmes/route.ts", "src/app/animes/page.tsx", "src/app/desenhos/page.tsx", "src/app/melhores/page.tsx", "src/lib/catalog-showcases.ts"];
for (const file of surfaces) test(`${file}: todas as consultas/count usam regra antes do take`, () => {
  const code = fs.readFileSync(path.resolve(file), "utf8");
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let queries = 0;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(source);
      if (["prisma.filme", "prisma.serie"].includes(owner) && ["findMany", "count"].includes(node.expression.name.text)) {
        queries++;
        const args = node.arguments[0] as ts.ObjectLiteralExpression;
        const where = args.properties.find(p => p.name?.getText(source) === "where") as ts.PropertyAssignment;
        assert.ok(where, "where obrigatório");
        assert.ok(ts.isCallExpression(where.initializer), "filtro no banco, não pós-filter");
        assert.equal((where.initializer as ts.CallExpression).expression.getText(source), owner === "prisma.filme" ? "filmeDisponivel" : "serieDisponivel");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(queries > 0);
});

test("popular-sync não cria catálogo e conserva telemetria; cleanup independe do rank", () => {
  const source = fs.readFileSync("src/app/api/cron/popular-sync/route.ts", "utf8");
  assert.doesNotMatch(source, /createStubs|(?:filme|serie)\.create(?:Many)?\(/);
  assert.match(source, /const stubsCreated = 0/);
  assert.match(source, /cleanupCatalogStubs\(prisma\)/);
  assert.match(source, /missing: missingSeries.length/);
  for (const rule of [FILME_STUB_SEM_PLAYER, SERIE_STUB_SEM_PLAYER]) {
    assert.equal(JSON.stringify(rule).includes("popularRank"), false);
    assert.deepEqual(rule.id, { startsWith: "tmdb_" });
    assert.ok(rule.NOT, "nega disponibilidade para preservar conteúdo real");
  }
});

test("cleanup apaga só tmdb_* indisponível com/sem rank; preserva real e catálogo original", async () => {
  const filmes = [
    { id: "tmdb_vazio", urlDub: null, urlLeg: null, popularRank: 1 },
    { id: "tmdb_sem_rank", urlDub: null, urlLeg: null, popularRank: null },
    { id: "tmdb_real", urlDub: "player", urlLeg: null, popularRank: 3 },
    { id: "original", urlDub: null, urlLeg: null, popularRank: 4 },
    { id: "tmdbXnao_stub", urlDub: null, urlLeg: null, popularRank: 5 },
  ];
  const series = [
    { id: "tmdb_vazia", episodios: [], popularRank: 1 },
    { id: "tmdb_metadata", episodios: [{ urlDub: null, urlLeg: null }], popularRank: 2 },
    { id: "tmdb_real", episodios: [{ urlDub: null, urlLeg: "player" }], popularRank: 3 },
    { id: "original", episodios: [], popularRank: 4 },
    { id: "tmdbXnao_stub", episodios: [], popularRank: 5 },
  ];
  const deleted: Record<string, string[]> = {};
  const model = (rows: any[], key: string) => ({
    // Simula inclusive o '_' wildcard do LIKE: candidatos falsos não podem
    // chegar a nenhuma exclusão de relações ou de catálogo.
    findMany: async ({ where }: any) => rows.filter(r => matches(r, where) || r.id === "tmdbXnao_stub").map(r => ({ id: r.id })),
    deleteMany: async ({ where }: any) => { deleted[key] = rows.filter(r => matches(r, where)).map(r => r.id); return { count: deleted[key].length }; },
  });
  const dependentes: any[] = [];
  const child = { deleteMany: async (args: any) => { dependentes.push(args.where); return { count: 0 }; } };
  const tx = { filme: model(filmes, "filmes"), serie: model(series, "series"), filmeGenero: child, serieGenero: child, episodio: child };
  const db = { $transaction: async (run: any, opts: any) => { assert.equal(opts.isolationLevel, "Serializable"); return run(tx); } };
  assert.deepEqual(await cleanupCatalogStubs(db as any), { filmes: 2, series: 2 });
  assert.deepEqual(deleted.filmes, ["tmdb_vazio", "tmdb_sem_rank"]);
  assert.deepEqual(deleted.series, ["tmdb_vazia", "tmdb_metadata"]);
  assert.ok(dependentes.every(f => !JSON.stringify(f).includes("tmdb_real") && !JSON.stringify(f).includes("tmdbXnao_stub")));
});

test("falha na limpeza de relações não é escondida nem continua apagando catálogo", async () => {
  let parentDeleted = false;
  const model = { findMany: async () => [{ id: "tmdb_stub" }], deleteMany: async () => { parentDeleted = true; } };
  const tx = { filme: model, serie: model, filmeGenero: { deleteMany: async () => { throw Error("FK fixture"); } } };
  const db = { $transaction: async (run: any) => run(tx) };
  await assert.rejects(cleanupCatalogStubs(db as any), /FK fixture/);
  assert.equal(parentDeleted, false);
});
