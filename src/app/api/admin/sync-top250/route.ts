export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { getTopRatedMovies, getTopRatedTV, TmdbItem } from "@/lib/tmdb";

async function fetchPages(
  fn: (page: number) => Promise<{ results: TmdbItem[]; total_pages: number } | null>,
  count: number,
): Promise<TmdbItem[]> {
  const pages = Math.ceil(count / 20);
  const results = await Promise.all(Array.from({ length: pages }, (_, i) => fn(i + 1)));
  return results.flatMap((p) => p?.results ?? []).slice(0, count);
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const [topFilmes, topSeries] = await Promise.all([
    fetchPages(getTopRatedMovies, 250),
    fetchPages(getTopRatedTV, 250),
  ]);

  // Mapeia tmdbId → posição (1-indexado)
  const filmeRank = new Map(topFilmes.map((f, i) => [String(f.id), i + 1]));
  const serieRank = new Map(topSeries.map((s, i) => [String(s.id), i + 1]));

  // Busca todos os itens com tmdbId no DB
  const [dbFilmes, dbSeries] = await Promise.all([
    prisma.filme.findMany({ where: { tmdbId: { not: null } }, select: { id: true, tmdbId: true, top250: true } }),
    prisma.serie.findMany({ where: { tmdbId: { not: null } }, select: { id: true, tmdbId: true, top250: true } }),
  ]);

  let filmesAtualizados = 0;
  let seriesAtualizadas = 0;

  await Promise.all([
    ...dbFilmes.map((f) => {
      const rank = filmeRank.get(f.tmdbId!) ?? null;
      if (f.top250 === rank) return Promise.resolve();
      filmesAtualizados++;
      return prisma.filme.update({ where: { id: f.id }, data: { top250: rank } });
    }),
    ...dbSeries.map((s) => {
      const rank = serieRank.get(s.tmdbId!) ?? null;
      if (s.top250 === rank) return Promise.resolve();
      seriesAtualizadas++;
      return prisma.serie.update({ where: { id: s.id }, data: { top250: rank } });
    }),
  ]);

  return NextResponse.json({
    ok: true,
    filmes: { total: dbFilmes.length, atualizados: filmesAtualizados },
    series: { total: dbSeries.length, atualizadas: seriesAtualizadas },
  });
}
