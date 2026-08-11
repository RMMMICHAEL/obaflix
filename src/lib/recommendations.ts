import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export type RecommendationKind = "filme" | "serie" | "anime" | "desenho";

export interface RecommendationCard {
  id: string;
  tipo: RecommendationKind;
  titulo: string;
  poster: string | null;
  logo: string | null;
  ano: number | null;
  nota: number | null;
  urlDub: string | null;
  urlLeg: string | null;
}

export interface RecommendationRow {
  id: string;
  titulo: string;
  items: RecommendationCard[];
}

type Signal = {
  weight: number;
  source: "like" | "dislike" | "watchlist" | "history";
};

const filmSelect = {
  id: true,
  titulo: true,
  poster: true,
  logo: true,
  ano: true,
  nota: true,
  popularidade: true,
  createdAt: true,
  urlDub: true,
  urlLeg: true,
  generos: { select: { generoId: true } },
} satisfies Prisma.FilmeSelect;

const seriesSelect = {
  id: true,
  titulo: true,
  poster: true,
  logo: true,
  ano: true,
  nota: true,
  popularidade: true,
  createdAt: true,
  tipo: true,
  generos: { select: { generoId: true } },
  episodios: {
    where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
    select: { urlDub: true, urlLeg: true },
    take: 20,
  },
} satisfies Prisma.SerieSelect;

type FilmRow = Prisma.FilmeGetPayload<{ select: typeof filmSelect }>;
type SeriesRow = Prisma.SerieGetPayload<{ select: typeof seriesSelect }>;

function keyFor(conteudoId: string, conteudoTipo: string) {
  return `${conteudoTipo === "filme" ? "filme" : "serie"}:${conteudoId}`;
}

function normalizeSeriesType(tipo: string): RecommendationKind {
  return tipo === "anime" || tipo === "desenho" ? tipo : "serie";
}

function seriesAudio(episodios: Array<{ urlDub: string | null; urlLeg: string | null }>) {
  return {
    urlDub: episodios.some((ep) => Boolean(ep.urlDub)) ? "disponível" : null,
    urlLeg: episodios.some((ep) => Boolean(ep.urlLeg)) ? "disponível" : null,
  };
}

function toFilmCard(row: FilmRow): RecommendationCard {
  return {
    id: row.id,
    tipo: "filme",
    titulo: row.titulo,
    poster: row.poster,
    logo: row.logo,
    ano: row.ano,
    nota: row.nota,
    urlDub: row.urlDub,
    urlLeg: row.urlLeg,
  };
}

function toSeriesCard(row: SeriesRow): RecommendationCard {
  const audio = seriesAudio(row.episodios ?? []);
  return {
    id: row.id,
    tipo: normalizeSeriesType(row.tipo),
    titulo: row.titulo,
    poster: row.poster,
    logo: row.logo,
    ano: row.ano,
    nota: row.nota,
    ...audio,
  };
}

export async function getRecommendationsForUser(userId: string): Promise<{ rows: RecommendationRow[]; signalCount: number }> {
  const [likes, watchlist, history] = await Promise.all([
    prisma.like.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { conteudoId: true, conteudoTipo: true, valor: true },
    }),
    prisma.watchlist.findMany({
      where: { userId },
      orderBy: { addedAt: "desc" },
      select: { conteudoId: true, conteudoTipo: true },
    }),
    prisma.watchHistory.findMany({
      where: { userId, progressoSeg: { gt: 30 } },
      orderBy: { updatedAt: "desc" },
      take: 120,
      select: { conteudoId: true, conteudoTipo: true, concluido: true },
    }),
  ]);

  const signals = new Map<string, Signal>();
  for (const like of likes) {
    signals.set(keyFor(like.conteudoId, like.conteudoTipo), {
      weight: like.valor > 0 ? 6 : -5,
      source: like.valor > 0 ? "like" : "dislike",
    });
  }
  for (const item of watchlist) {
    const key = keyFor(item.conteudoId, item.conteudoTipo);
    const current = signals.get(key);
    if (!current || current.weight >= 0) signals.set(key, { weight: (current?.weight ?? 0) + 4, source: current?.source ?? "watchlist" });
  }
  for (const item of history) {
    const key = keyFor(item.conteudoId, item.conteudoTipo);
    const current = signals.get(key);
    if (current?.source === "dislike") continue;
    const historyWeight = item.concluido ? 2.5 : 1.25;
    if (!current) signals.set(key, { weight: historyWeight, source: "history" });
    else if (current.source === "history") current.weight = Math.max(current.weight, historyWeight);
  }

  const signalFilmIds = [...signals.keys()].filter((key) => key.startsWith("filme:")).map((key) => key.slice(6));
  const signalSeriesIds = [...signals.keys()].filter((key) => key.startsWith("serie:")).map((key) => key.slice(6));

  const [signalFilms, signalSeries] = await Promise.all([
    signalFilmIds.length
      ? prisma.filme.findMany({ where: { id: { in: signalFilmIds } }, select: filmSelect })
      : Promise.resolve([]),
    signalSeriesIds.length
      ? prisma.serie.findMany({ where: { id: { in: signalSeriesIds } }, select: seriesSelect })
      : Promise.resolve([]),
  ]);

  const signalMedia = new Map<string, FilmRow | SeriesRow>();
  for (const row of signalFilms) signalMedia.set(`filme:${row.id}`, row);
  for (const row of signalSeries) signalMedia.set(`serie:${row.id}`, row);

  const genreWeights = new Map<number, number>();
  let filmAffinity = 0;
  let seriesAffinity = 0;
  for (const [key, signal] of signals) {
    const media = signalMedia.get(key);
    if (!media) continue;
    const genreDelta = signal.source === "dislike" ? -1.5 : Math.min(5, signal.weight);
    for (const genre of media.generos ?? []) {
      genreWeights.set(genre.generoId, (genreWeights.get(genre.generoId) ?? 0) + genreDelta);
    }
    if (signal.weight > 0) {
      if (key.startsWith("filme:")) filmAffinity += signal.weight;
      else seriesAffinity += signal.weight;
    }
  }

  const excludedFilmIds = signalFilmIds;
  const excludedSeriesIds = signalSeriesIds;
  const [candidateFilms, candidateSeries] = await Promise.all([
    prisma.filme.findMany({
      where: {
        id: excludedFilmIds.length ? { notIn: excludedFilmIds } : undefined,
        OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }],
      },
      orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
      take: 180,
      select: filmSelect,
    }),
    prisma.serie.findMany({
      where: {
        id: excludedSeriesIds.length ? { notIn: excludedSeriesIds } : undefined,
        episodios: { some: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] } },
      },
      orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
      take: 180,
      select: seriesSelect,
    }),
  ]);

  const score = (row: FilmRow | SeriesRow, kind: "filme" | "serie") => {
    const genreScore = (row.generos ?? []).reduce((total: number, genre: { generoId: number }) => total + (genreWeights.get(genre.generoId) ?? 0), 0);
    const quality = (row.nota ?? 0) * 0.3;
    const popularity = Math.log10(Math.max(1, row.popularidade ?? 1)) * 0.8;
    const affinityTotal = filmAffinity + seriesAffinity;
    const affinity = affinityTotal > 0
      ? (kind === "filme" ? filmAffinity : seriesAffinity) / affinityTotal
      : 0.5;
    const freshness = row.ano && row.ano >= new Date().getFullYear() - 2 ? 0.8 : 0;
    return genreScore + quality + popularity + affinity * 2 + freshness;
  };

  const ranked = [
    ...candidateFilms.map((row) => ({ row, kind: "filme" as const, score: score(row, "filme"), card: toFilmCard(row) })),
    ...candidateSeries.map((row) => ({ row, kind: "serie" as const, score: score(row, "serie"), card: toSeriesCard(row) })),
  ].sort((a, b) => b.score - a.score);

  const rows: RecommendationRow[] = [];
  const personalized = ranked.slice(0, 24).map((item) => item.card);
  if (personalized.length >= 6) {
    rows.push({
      id: "for-you",
      titulo: signals.size > 0 ? "Escolhidos para você" : "Boas histórias para começar",
      items: personalized,
    });
  }

  const seedEntry = [...signals.entries()].find(([, signal]) => signal.source === "like" && signal.weight > 0)
    ?? [...signals.entries()].find(([, signal]) => signal.source === "watchlist" && signal.weight > 0)
    ?? [...signals.entries()].find(([, signal]) => signal.source === "history" && signal.weight > 0);
  if (seedEntry) {
    const seed = signalMedia.get(seedEntry[0]);
    const seedGenres = new Set<number>((seed?.generos ?? []).map((genre: { generoId: number }) => genre.generoId));
    const similar = ranked
      .filter((item) => item.row.generos?.some((genre: { generoId: number }) => seedGenres.has(genre.generoId)))
      .slice(0, 20)
      .map((item) => item.card);
    if (seed?.titulo && similar.length >= 6) {
      rows.push({ id: "because-seed", titulo: `Porque você gostou de ${seed.titulo}`, items: similar });
    }
  }

  const watchlistCards = watchlist
    .map((item) => {
      const key = keyFor(item.conteudoId, item.conteudoTipo);
      const media = signalMedia.get(key);
      if (!media) return null;
      return "episodios" in media ? toSeriesCard(media) : toFilmCard(media);
    })
    .filter(Boolean) as RecommendationCard[];
  if (watchlistCards.length > 0) rows.push({ id: "my-list", titulo: "Minha lista", items: watchlistCards });

  const anime = ranked.filter((item) => item.card.tipo === "anime").slice(0, 20).map((item) => item.card);
  if (anime.length >= 6) rows.push({ id: "anime-radar", titulo: "Animes para entrar no seu radar", items: anime });

  const dubbed = ranked.filter((item) => Boolean(item.card.urlDub)).slice(0, 20).map((item) => item.card);
  if (dubbed.length >= 6) rows.push({ id: "dubbed", titulo: "Dublados para maratonar", items: dubbed });

  return { rows, signalCount: signals.size };
}
