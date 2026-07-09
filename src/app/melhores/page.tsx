import { getTopRatedMovies, getTopRatedTV, getPopularMovies, getPopularTV, imgUrl, TmdbItem } from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { MelhoresClient, type ChartItem } from "./MelhoresClient";

export const revalidate = 3600;

async function fetchPages(
  fn: (page: number) => Promise<{ results: TmdbItem[]; total_pages: number } | null>,
  count: number
): Promise<TmdbItem[]> {
  const pages = Math.ceil(count / 20);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => fn(i + 1))
  );
  return results.flatMap((p) => p?.results ?? []).slice(0, count);
}

export default async function MelhoresPage() {
  const [topFilmesRaw, topSeriesRaw, popFilmesRaw, popSeriesRaw] = await Promise.all([
    fetchPages(getTopRatedMovies, 250),
    fetchPages(getTopRatedTV, 250),
    fetchPages(getPopularMovies, 100),
    fetchPages(getPopularTV, 100),
  ]);

  const toTmdbIds = (items: TmdbItem[]) =>
    [...new Set(items.map((i) => String(i.id)))];

  const filmeIds = toTmdbIds([...topFilmesRaw, ...popFilmesRaw]);
  const serieIds = toTmdbIds([...topSeriesRaw, ...popSeriesRaw]);

  const [dbFilmes, dbSeries] = await Promise.all([
    prisma.filme.findMany({
      where: { tmdbId: { in: filmeIds } },
      select: { id: true, tmdbId: true },
    }),
    prisma.serie.findMany({
      where: { tmdbId: { in: serieIds } },
      select: { id: true, tmdbId: true },
    }),
  ]);

  const filmeMap = new Map(dbFilmes.map((f) => [f.tmdbId ?? "", f.id]));
  const serieMap = new Map(dbSeries.map((s) => [s.tmdbId ?? "", s.id]));

  const toChart = (items: TmdbItem[], tipo: "filme" | "serie"): ChartItem[] => {
    const map = tipo === "filme" ? filmeMap : serieMap;
    return items.map((item) => ({
      tmdbId: String(item.id),
      titulo: (item.title ?? item.name ?? "—").trim(),
      ano: (item.release_date ?? item.first_air_date ?? "").slice(0, 4),
      nota: Math.round((item.vote_average ?? 0) * 10) / 10,
      poster: item.poster_path ? imgUrl(item.poster_path, "w185") : null,
      catalogId: map.get(String(item.id)) ?? null,
    }));
  };

  return (
    <MelhoresClient
      topFilmes={toChart(topFilmesRaw, "filme")}
      topSeries={toChart(topSeriesRaw, "serie")}
      popFilmes={toChart(popFilmesRaw, "filme")}
      popSeries={toChart(popSeriesRaw, "serie")}
    />
  );
}
