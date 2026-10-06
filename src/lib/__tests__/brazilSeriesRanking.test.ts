import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  BRAZIL_SERIES_CATEGORIES, BRAZIL_SERIES_ENDPOINT,
  createBrazilSeriesRanking, orderBrazilSeriesRows, parseBrazilSeriesRanking,
  parseBrazilSeriesLiveSnapshot, paginateBrazilSeriesRows,
} from "../brazil-series-ranking";

function payload(ids: (string | null)[]) {
  return { data: { streamingCharts: { edges: ids.map((imdbId, i) => ({
    streamingChartInfo: { rank: i + 1 },
    node: { objectType: "SHOW", content: { externalIds: { imdbId } } },
  })) } } };
}
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === "AND") return value.every((part: any) => matches(row, part));
    if (key === "OR") return value.some((part: any) => matches(row, part));
    if (key === "NOT") return !matches(row, value);
    if (!value || typeof value !== "object") return row[key] === value;
    if ("some" in value) return row[key].some((part: any) => matches(part, value.some));
    if ("in" in value) return value.in.includes(row[key]);
    if ("not" in value) return row[key] !== value.not;
    throw Error("Operador não coberto pela fixture");
  });
}
function row(id: string, extra: object = {}) {
  return { id, imdbId: `tt${id}`, tipo: "serie", generos: [{ generoId: 18 }],
    episodios: [{ urlDub: "player", urlLeg: null }], ...extra };
}
function fixture(sources: Partial<Record<"day" | "week" | "month", (string | null)[]>>, rows: any[]) {
  const cache = new Map<string, string>();
  const calls: string[] = [];
  const writes: { key: string; ex: number | undefined }[] = [];
  const ranking = createBrazilSeriesRanking({
    cache: () => ({
      get: async (key) => cache.get(key) ?? null,
      set: async (key, value, opts) => { cache.set(key, String(value)); writes.push({ key, ex: opts?.ex }); return "OK"; },
    }),
    fetch: async (url, init) => {
      assert.equal(url, BRAZIL_SERIES_ENDPOINT);
      const query = JSON.parse(String(init?.body)).query;
      assert.match(query, /country: BR/); assert.match(query, /objectType: SHOW/);
      const window = (Object.keys(BRAZIL_SERIES_CATEGORIES) as (keyof typeof BRAZIL_SERIES_CATEGORIES)[])
        .find((key) => query.includes(BRAZIL_SERIES_CATEGORIES[key]))!;
      calls.push(window);
      if (!sources[window]) throw Error("Fonte fora do ar");
      // Fonte saudável realista; esses IDs adicionais não existem no catálogo.
      const padding = Array.from({ length: 50 }, (_, index) => `tt${9000000 + index}`);
      return new Response(JSON.stringify(payload([...sources[window]!, ...padding])), { status: 200 });
    },
    findSeries: async (where) => rows.filter((item) => matches(item, where)).reverse(),
  });
  return { ranking, cache, calls, writes };
}

test("daily usa DAILY BR/SHOW, weekly usa WEEKLY BR/SHOW", async () => {
  const f = fixture({ day: ["tt1"], week: ["tt2"] }, [row("1"), row("2")]);
  assert.deepEqual(await f.ranking("day", 1), ["1"]);
  assert.deepEqual(await f.ranking("week", 1), ["2"]);
  assert.deepEqual(f.calls, ["day", "week"]);
});
test("weekly incompleto completa por monthly; duplicatas não ocupam posições", async () => {
  const f = fixture({ week: ["tt2", "tt2"], month: ["tt2", "tt1", "tt3"] }, [row("1"), row("2"), row("3")]);
  assert.deepEqual(await f.ranking("week", 3), ["2", "1", "3"]);
  assert.deepEqual(f.calls, ["week", "month"]);
});
test("daily incompleto completa por weekly sem recorrer a monthly", async () => {
  const f = fixture({ day: ["tt3"], week: ["tt2", "tt1"] }, [row("1"), row("2"), row("3")]);
  assert.deepEqual(await f.ranking("day", 3), ["3", "2", "1"]);
  assert.deepEqual(f.calls, ["day", "week"]);
});
test("sem IMDb ou sem correspondência exata: pula, sem fuzzy match", async () => {
  const f = fixture({ week: [null, "tt999", "tt1"] }, [row("1")]);
  assert.deepEqual(await f.ranking("week", 1), ["1"]);
});
test("parser deduplica e ordena por rank mesmo se edges vierem fora de ordem", () => {
  const data = payload(["tt3", "tt1", "tt3", null]);
  data.data.streamingCharts.edges.reverse();
  assert.deepEqual(parseBrazilSeriesRanking(data), ["tt3", "tt1"]);
});
for (const [name, extra] of [
  ["sem episódios", { episodios: [] }],
  ["episódio sem player", { episodios: [{ urlDub: null, urlLeg: null }] }],
  ["News", { generos: [{ generoId: 10763 }] }],
  ["Reality", { generos: [{ generoId: 10764 }] }],
  ["Talk", { generos: [{ generoId: 10767 }] }],
  ["anime", { tipo: "anime" }],
  ["desenho", { tipo: "desenho" }],
] as const) {
  test(`exclui ${name} antes de completar o limite; Scripted continua elegível`, async () => {
    const f = fixture({ week: ["tt1", "tt2"] }, [row("1", extra), row("2")]);
    assert.deepEqual(await f.ranking("week", 1), ["2"]);
  });
}
test("player legendado também é elegível", async () => {
  const f = fixture({ week: ["tt1"] }, [row("1", { episodios: [{ urlDub: null, urlLeg: "player" }] })]);
  assert.deepEqual(await f.ranking("week", 1), ["1"]);
});
test("IN fora de ordem retorna a ordem externa e omite IDs ausentes", () => {
  assert.deepEqual(orderBrazilSeriesRows(["c", "b", "a", "d"], [{ id: "a" }, { id: "c" }, { id: "b" }]),
    [{ id: "c" }, { id: "b" }, { id: "a" }]);
});
test("cópias locais de um IMDb têm seleção determinística", async () => {
  const f = fixture({ week: ["tt1"] }, [row("z", { imdbId: "tt1" }), row("a", { imdbId: "tt1" })]);
  assert.deepEqual(await f.ranking("week", 1), ["a"]);
});
test("fresh evita outra chamada externa, mas revalida disponibilidade local", async () => {
  const rows = [row("1")];
  const f = fixture({ week: ["tt1"] }, rows);
  assert.deepEqual(await f.ranking("week", 1), ["1"]);
  rows[0].episodios = [];
  assert.deepEqual(await f.ranking("week", 1), []);
  assert.equal(f.calls.filter((call) => call === "week").length, 1);
  assert.deepEqual(f.writes, [
    { key: "catalog:br:series:week:fresh:v1", ex: 3600 },
    { key: "catalog:br:series:week:last-good:v1", ex: 2592000 },
  ]);
});
test("falha live usa last-good brasileiro", async () => {
  const f = fixture({}, [row("1")]);
  f.cache.set("catalog:br:series:week:last-good:v1", '["tt1"]');
  assert.deepEqual(await f.ranking("week", 1), ["1"]);
});
test("falha live sem snapshot retorna vazio, nunca TMDB global", async () => {
  const f = fixture({}, [row("1", { popularRank: 1, popularidade: 99999 })]);
  assert.deepEqual(await f.ranking("week", 10), []);
  assert.deepEqual(await f.ranking("day", 10), []);
  assert.ok(!readFileSync("src/lib/brazil-series-ranking.ts", "utf8").includes('from "./tmdb"'));
});
test("contrato inválido ou MOVIE não substitui snapshot válido", () => {
  assert.throws(() => parseBrazilSeriesRanking({ errors: [{ message: "erro" }] }));
  const data = payload(["tt1"]);
  data.data.streamingCharts.edges[0].node.objectType = "MOVIE";
  assert.throws(() => parseBrazilSeriesRanking(data));
});
test("cache corrompido é rejeitado; consulta live recupera lista", async () => {
  const f = fixture({ week: ["tt1"] }, [row("1")]);
  f.cache.set("catalog:br:series:week:fresh:v1", '{');
  assert.deepEqual(await f.ranking("week", 1), ["1"]);
});
test("erro HTTP ou contrato inválido usam last-good sem sobrescrever snapshot", async () => {
  for (const response of [new Response("bloqueado", { status: 403 }), new Response(JSON.stringify({ errors: [{ message: "contrato mudou" }] }))]) {
    let writes = 0;
    const ranking = createBrazilSeriesRanking({
      fetch: async () => response,
      cache: () => ({ get: async (key) => key.includes("last-good") ? '["tt1"]' : null,
        set: async () => { writes++; return "OK"; } }),
      findSeries: async () => [{ id: "1", imdbId: "tt1" }],
    });
    assert.deepEqual(await ranking("week", 1), ["1"]);
    assert.equal(writes, 0);
  }
});
test("chamadas concorrentes compartilham fetch da mesma janela", async () => {
  const f = fixture({ week: ["tt1"] }, [row("1")]);
  assert.deepEqual(await Promise.all([f.ranking("week", 1), f.ranking("week", 1)]), [["1"], ["1"]]);
  assert.deepEqual(f.calls, ["week"]);
});
test("HTTP 200 sem IMDb ou com cobertura degradada preserva fresh/last-good", async () => {
  for (const valid of [0, 1, 24, 249]) {
    const source = payload(Array.from({ length: 500 }, (_, index) => index < valid ? `tt${1000000 + index}` : null));
    const cache = new Map([["catalog:br:series:week:last-good:v1", '["tt1"]']]);
    let writes = 0;
    const ranking = createBrazilSeriesRanking({
      fetch: async () => new Response(JSON.stringify(source), { status: 200 }),
      cache: () => ({ get: async (key) => cache.get(key) ?? null, set: async () => { writes++; return "OK"; } }),
      findSeries: async () => [{ id: "1", imdbId: "tt1" }],
    });
    assert.deepEqual(await ranking("week", 1), ["1"]);
    assert.equal(writes, 0);
    assert.equal(cache.get("catalog:br:series:week:last-good:v1"), '["tt1"]');
    assert.equal(cache.has("catalog:br:series:week:fresh:v1"), false);
  }
});
test("sanidade aceita 250 IMDb únicos em 500; rejeita lista curta ou só duplicatas", () => {
  assert.equal(parseBrazilSeriesLiveSnapshot(payload(Array.from({ length: 500 }, (_, index) => index < 250 ? `tt${1000000 + index}` : null))).length, 250);
  assert.throws(() => parseBrazilSeriesLiveSnapshot(payload(["tt1"])));
  assert.throws(() => parseBrazilSeriesLiveSnapshot(payload(Array(500).fill("tt1"))));
});
test("fresh vazio preexistente não impede recuperar last-good", async () => {
  const f = fixture({}, [row("1")]);
  f.cache.set("catalog:br:series:week:fresh:v1", "[]");
  f.cache.set("catalog:br:series:week:last-good:v1", '["tt1"]');
  assert.deepEqual(await f.ranking("week", 1), ["1"]);
});
test("pagina só depois de filtrar gênero/ano/busca; total exclui ausentes", () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ id: String(i), genero: i % 2, ano: 2026, titulo: `Série ${i}` }));
  const ids = rows.map((item) => item.id);
  const filtered = rows.filter((item) => item.genero === 1 && item.ano === 2026 && item.titulo.includes("Série")).reverse();
  const first = paginateBrazilSeriesRows(ids, filtered, 1, 24);
  const second = paginateBrazilSeriesRows(ids, filtered, 2, 24);
  assert.equal(first.total, 35); assert.equal(second.total, 35);
  assert.deepEqual(first.series.map((item) => item.id), ids.filter((_, i) => i % 2 === 1).slice(0, 24));
  assert.deepEqual(second.series.map((item) => item.id), ids.filter((_, i) => i % 2 === 1).slice(24));
  assert.deepEqual(paginateBrazilSeriesRows(ids, filtered, 3, 24).series, []);
  assert.deepEqual(paginateBrazilSeriesRows([], filtered, 1, 24), { series: [], total: 0 });
});
for (const file of ["src/app/series/page.tsx", "src/app/api/series/route.ts"]) {
  test(`${file}: popular filtra todo ranking Brasil antes de total/paginação`, () => {
    const source = readFileSync(file, "utf8");
    assert.match(source, /getBrazilSeriesRanking\("week", BRAZIL_SERIES_BROWSE_LIMIT\)/);
    assert.match(source, /paginateBrazilSeriesRows\(brazilIds, rawSeries, page, limit\)/);
    assert.match(source, /orderBy: brazilIds \? undefined : orderBy/);
    assert.match(source, /skip: brazilIds \? undefined : skip/);
    assert.match(source, /take: brazilIds \? undefined : limit/);
    assert.match(source, /where\.generos/); assert.match(source, /where\.ano/); assert.match(source, /where\.titulo/);
    if (file.includes("api/")) {
      assert.match(source, /!tipo \|\| tipo === "serie"/);
      assert.match(source, /where\.id = \{ in: brazilIds \}/);
    } else {
      assert.doesNotMatch(source, /ordem === "popular"\s+\? \{ popularidade/);
      assert.match(source, /id: \{ in: brazilIds \}/);
    }
  });
}

// Lê a AST: identifica as queries por IDs Brasil e proíbe ordenação global nelas.
for (const file of ["src/components/home/HomeStreaming.tsx", "src/app/api/tv/home/route.ts",
  "src/app/melhores/page.tsx", "src/app/series/page.tsx", "src/app/api/home/route.ts", "src/app/android/page.tsx"]) {
  test(`${file}: week, ordem em memória e queries brasileiras sem fallback global`, () => {
    const text = readFileSync(file, "utf8");
    assert.match(text, /getBrazilSeriesRanking\("week",/);
    assert.match(text, /orderBrazilSeriesRows\(brWeekIds,/);
    if (file.includes("HomeStreaming") || file.includes("tv/home")) {
      assert.match(text, /getBrazilSeriesRanking\("day",/);
      assert.match(text, /orderBrazilSeriesRows\(brDayIds,/);
    }
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let brazilQueries = 0;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "prisma.serie.findMany") {
        const args = node.arguments[0];
        if (args && ts.isObjectLiteralExpression(args) && /in: br(?:Week|Day)Ids/.test(args.getText(ast))) {
          brazilQueries++;
          assert.ok(!args.properties.some((p) => p.name?.getText(ast) === "orderBy"));
          assert.doesNotMatch(args.getText(ast), /popularRank|popularidade|ORDEM_TOP10|ORDEM_POPULARIDADE/);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.equal(brazilQueries, file.includes("HomeStreaming") || file.includes("tv/home") ? 2 : 1);
    if (file.includes("HomeStreaming")) assert.match(text, /top10SeriesCards = dbRankSeries\.map/);
    if (file.includes("melhores")) {
      assert.match(text, /serieToChart\(s, index \+ 1\)/);
      assert.doesNotMatch(text, /serieToChart\(s, "popularRank"\)/);
    }
    if (file.includes("series/page")) assert.match(text, /titulo="Em Alta"[^\n]+verTodosHref="\/melhores"/);
  });
}
