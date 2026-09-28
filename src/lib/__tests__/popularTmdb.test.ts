import assert from "node:assert/strict";
import test from "node:test";
import { collectPopular, validatePopularBatch, type PopularFetchResult, type PopularPageFetcher, type TmdbResult } from "../popular-source";

/**
 * Simula o /popular do TMDB com cache por página: cada página é uma foto do
 * ranking num instante diferente. Com `overlap` itens repetidos por página,
 * a página k começa em (k-1)·(20-overlap) — as bordas se repetem, como foi
 * medido em produção (~15% de repetição no Top 500).
 */
function driftingSource(kind: "movie" | "tv", overlap: number, total = 2000): PopularPageFetcher {
  const ranking = Array.from({ length: total }, (_, i) => 1000 + i);
  return async (_path, page) => {
    const start = (page - 1) * (20 - overlap);
    const results: TmdbResult[] = ranking.slice(start, start + 20).map((id) => (kind === "movie" ? { id, title: `Filme ${id}` } : { id, name: `Série ${id}` }));
    return { results, bytes: 100 };
  };
}

const LIMIT = 500;

test("drift de paginação do TMDB: repetições são descartadas e o Top 500 fica completo com ranks contínuos", async () => {
  // A cada página, 3 itens da página anterior reaparecem (15%).
  const r = await collectPopular("/movie/popular", LIMIT, false, driftingSource("movie", 3));
  assert.equal(r.items.length, LIMIT);
  assert.equal(new Set(r.items.map((i) => i.tmdbId)).size, LIMIT);
  assert.deepEqual(r.items.map((i) => i.rank), Array.from({ length: LIMIT }, (_, i) => i + 1));
  assert.ok(r.stats.duplicates / r.stats.raw > 0.1, "o cenário reproduz a repetição real");
  assert.ok(r.stats.pages > 25 && r.stats.pages <= 38, `páginas lidas: ${r.stats.pages}`);
});

test("faixa histórica (46/500 ≈ 9% a 97/500 ≈ 19%) passa na guarda nova; a regra antiga de 5% reprovava", async () => {
  for (const drift of [2, 3, 4]) {
    const movies = await collectPopular("/movie/popular", LIMIT, false, driftingSource("movie", drift));
    const series = await collectPopular("/tv/popular", LIMIT, true, driftingSource("tv", drift));
    assert.doesNotThrow(() => validatePopularBatch(LIMIT, movies, series), `drift ${drift}`);
    assert.ok(movies.stats.duplicates / movies.stats.raw > 0.05, "acima do limite antigo");
  }
});

test("paginação quebrada (mesma página repetida) continua bloqueada como corrupção", async () => {
  const samePage: PopularPageFetcher = async () => ({ results: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `F${i}` })), bytes: 10 });
  const movies = await collectPopular("/movie/popular", LIMIT, false, samePage);
  const series = await collectPopular("/tv/popular", LIMIT, true, driftingSource("tv", 0));
  assert.throws(() => validatePopularBatch(LIMIT, movies, series), /Poucos filmes retornados: 20\/500/);
  // Mesmo que houvesse únicos suficientes, a taxa de repetição anômala reprova.
  const inflated: PopularFetchResult = { ...movies, items: series.items, stats: { raw: 1000, duplicates: 600, typeMismatches: 0, pages: 50 } };
  assert.throws(() => validatePopularBatch(LIMIT, inflated, series), /Duplicidade anômala em filmes: 600\/1000/);
});

test("resposta do tipo errado (séries no endpoint de filmes) é bloqueada pelo formato, não por ID", async () => {
  const wrongType = await collectPopular("/movie/popular", LIMIT, false, driftingSource("tv", 0));
  const series = await collectPopular("/tv/popular", LIMIT, true, driftingSource("tv", 0));
  assert.equal(wrongType.stats.typeMismatches, wrongType.stats.raw);
  assert.throws(() => validatePopularBatch(LIMIT, wrongType, series), /Tipo inesperado em filmes/);
});

test("IDs numéricos iguais entre filme e série não reprovam mais (espaços de ID distintos no TMDB)", async () => {
  // Mesmo ranking numérico nos dois: 500 IDs "em comum", mas cada lista tem o formato certo.
  const movies = await collectPopular("/movie/popular", LIMIT, false, driftingSource("movie", 0));
  const series = await collectPopular("/tv/popular", LIMIT, true, driftingSource("tv", 0));
  assert.doesNotThrow(() => validatePopularBatch(LIMIT, movies, series));
});

test("falha de rede no meio mantém a guarda de volume", async () => {
  const flaky: PopularPageFetcher = async (path, page) => (page > 10 ? null : driftingSource("movie", 0)(path, page));
  const movies = await collectPopular("/movie/popular", LIMIT, false, flaky);
  const series = await collectPopular("/tv/popular", LIMIT, true, driftingSource("tv", 0));
  assert.equal(movies.items.length, 200);
  assert.throws(() => validatePopularBatch(LIMIT, movies, series), /Poucos filmes retornados: 200\/500/);
});

test("rota usa as guardas compartilhadas e não tem mais a regra de sobreposição por ID", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/app/api/cron/popular-sync/route.ts", "utf8");
  assert.match(src, /validatePopularBatch\(FETCH_LIMIT, movies, series\)/);
  assert.doesNotMatch(src, /Sobreposição suspeita/);
  assert.doesNotMatch(src, /MAX_DUP_RATIO\s*=\s*0\.05/);
});
