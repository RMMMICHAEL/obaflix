/**
 * Busca as posições Top 250 da TMDB e grava em Filme.top250 / Serie.top250.
 *
 * Uso:
 *   npx tsx scripts/sync-top250.ts
 *
 * A TMDB top_rated retorna 20 itens por página. São necessárias 13 páginas
 * para cobrir as 250 primeiras posições (13 × 20 = 260 ≥ 250).
 * Itens além da posição 250 recebem top250 = null.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";
const PAGES = 13; // 13 × 20 = 260, cobre Top 250

if (!TMDB_KEY) {
  console.error("TMDB_API_KEY não configurada");
  process.exit(1);
}

async function fetchTopRated(type: "movie" | "tv", page: number) {
  const url = `${BASE}/${type}/top_rated?api_key=${TMDB_KEY}&language=pt-BR&page=${page}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${type}/top_rated p${page}: ${res.status}`);
  return (await res.json()) as { results: { id: number }[] };
}

async function buildRankMap(type: "movie" | "tv"): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let rank = 1;
  for (let p = 1; p <= PAGES; p++) {
    const data = await fetchTopRated(type, p);
    for (const item of data.results) {
      if (rank <= 250) map.set(String(item.id), rank);
      rank++;
    }
    // Pequena pausa para não estourar rate-limit da TMDB
    await new Promise((r) => setTimeout(r, 100));
  }
  return map;
}

async function syncFilmes(rankMap: Map<string, number>) {
  const filmes = await prisma.filme.findMany({
    where: { tmdbId: { not: null } },
    select: { id: true, tmdbId: true },
  });

  let updated = 0;
  for (const f of filmes) {
    const rank = rankMap.get(f.tmdbId!) ?? null;
    const current = await prisma.filme.findUnique({ where: { id: f.id }, select: { top250: true } });
    if (current?.top250 !== rank) {
      await prisma.filme.update({ where: { id: f.id }, data: { top250: rank } });
      updated++;
    }
  }
  return { total: filmes.length, updated };
}

async function syncSeries(rankMap: Map<string, number>) {
  const series = await prisma.serie.findMany({
    where: { tmdbId: { not: null } },
    select: { id: true, tmdbId: true },
  });

  let updated = 0;
  for (const s of series) {
    const rank = rankMap.get(s.tmdbId!) ?? null;
    const current = await prisma.serie.findUnique({ where: { id: s.id }, select: { top250: true } });
    if (current?.top250 !== rank) {
      await prisma.serie.update({ where: { id: s.id }, data: { top250: rank } });
      updated++;
    }
  }
  return { total: series.length, updated };
}

async function main() {
  console.log("Buscando Top 250 de filmes da TMDB…");
  const movieRanks = await buildRankMap("movie");
  console.log(`  ${movieRanks.size} posições mapeadas`);

  console.log("Buscando Top 250 de séries da TMDB…");
  const tvRanks = await buildRankMap("tv");
  console.log(`  ${tvRanks.size} posições mapeadas`);

  console.log("Sincronizando filmes…");
  const fStats = await syncFilmes(movieRanks);
  console.log(`  ${fStats.updated}/${fStats.total} filmes atualizados`);

  console.log("Sincronizando séries…");
  const sStats = await syncSeries(tvRanks);
  console.log(`  ${sStats.updated}/${sStats.total} séries atualizadas`);

  console.log("Concluído.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
