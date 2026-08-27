import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { ANIME_HOME_EXCLUSIONS } from "@/lib/editorialCatalog";

export type RecommendationKind = "filme" | "serie" | "anime" | "desenho";

/**
 * O card desenha arte e nome, e o nome vem do logo oficial. `ano`, `nota`,
 * `urlDub` e `urlLeg` viajavam na resposta sem nunca serem renderizados — 88
 * cards por visita carregando campos mortos. O que a pontuação e os filtros
 * precisam (nota, popularidade, gêneros, áudio) fica no lado do servidor, em
 * `PoolItem`, e não atravessa a rede.
 */
export interface RecommendationCard {
  id: string;
  tipo: RecommendationKind;
  titulo: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
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

// ── Pool compartilhado ──────────────────────────────────────────────────────

/**
 * O pool de candidatos é o mesmo para todos os usuários: os títulos mais
 * populares que têm stream. Antes ele era relido a cada visita porque o `notIn`
 * dos itens já vistos entrava na própria query — o que tornava "pessoal" uma
 * consulta cujo resultado só diferia por meia dúzia de linhas.
 *
 * Agora a query roda sem o `notIn` e a exclusão acontece em memória, o que
 * permite guardar um único resultado compartilhado.
 *
 * O `take` é maior que os 180 originais só para dar folga à exclusão — medido no
 * usuário com mais sinais do banco, 6 filmes e 67 séries. Depois de excluir, a
 * lista é cortada de volta em 180 por tipo (`CANDIDATOS_POR_TIPO`), que é
 * exatamente o que o `take` fazia depois do `notIn`. Sem esse corte o resultado
 * mudaria: com mais candidatos disputando as vagas, as prateleiras do fim do
 * ranking — "Dublados para maratonar" sai da posição ~85 — trocavam metade dos
 * títulos. Barato não é motivo para entregar coisa diferente.
 *
 * Nada aqui depende de usuário, então não há o que isolar — é catálogo público,
 * ordenado por popularidade, que muda em escala de horas.
 */
const POOL_TAKE = 260;
const CANDIDATOS_POR_TIPO = 180;
const POOL_REVALIDATE = 900; // 15 min

interface PoolItem {
  id: string;
  tipo: RecommendationKind;
  titulo: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
  ano: number | null;
  nota: number | null;
  popularidade: number | null;
  generoIds: number[];
  temDub: boolean;
  temLeg: boolean;
}

const ordemPopular = [
  { popularidade: { sort: "desc", nulls: "last" } },
  { nota: "desc" },
] as const;

async function carregarPool(): Promise<{ filmes: PoolItem[]; series: PoolItem[] }> {
  const [filmes, series] = await Promise.all([
    prisma.filme.findMany({
      where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
      orderBy: [...ordemPopular],
      take: POOL_TAKE,
      select: {
        id: true, titulo: true, poster: true, background: true, logo: true,
        ano: true, nota: true, popularidade: true,
        urlDub: true, urlLeg: true,
        generos: { select: { generoId: true } },
      },
    }),
    prisma.serie.findMany({
      where: { episodios: { some: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] } } },
      orderBy: [...ordemPopular],
      take: POOL_TAKE,
      select: {
        id: true, titulo: true, poster: true, background: true, logo: true,
        ano: true, nota: true, popularidade: true, tipo: true,
        generos: { select: { generoId: true } },
        // Só para derivar dois booleanos. O array não entra no cache — vira
        // `temDub`/`temLeg` logo abaixo. Trocar isso por colunas em Serie é a
        // fase seguinte, tratada em separado.
        episodios: {
          where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
          select: { urlDub: true, urlLeg: true },
          take: 20,
        },
      },
    }),
  ]);

  // Separados por tipo: o corte em 180 é por modelo, como era o `take`.
  return {
    filmes: filmes.map((f): PoolItem => ({
      id: f.id, tipo: "filme", titulo: f.titulo, poster: f.poster, background: f.background, logo: f.logo,
      ano: f.ano, nota: f.nota, popularidade: f.popularidade,
      generoIds: f.generos.map((g) => g.generoId),
      temDub: Boolean(f.urlDub), temLeg: Boolean(f.urlLeg),
    })),
    series: series.map((s): PoolItem => ({
      id: s.id, tipo: normalizeSeriesType(s.tipo), titulo: s.titulo, poster: s.poster, background: s.background, logo: s.logo,
      ano: s.ano, nota: s.nota, popularidade: s.popularidade,
      generoIds: s.generos.map((g) => g.generoId),
      temDub: s.episodios.some((ep) => Boolean(ep.urlDub)),
      temLeg: s.episodios.some((ep) => Boolean(ep.urlLeg)),
    })),
  };
}

const getPoolCompartilhado = unstable_cache(
  carregarPool,
  ["recommendations-pool-v1"],
  { revalidate: POOL_REVALIDATE, tags: ["recommendations-pool"] },
);

// ── Sinais do usuário ───────────────────────────────────────────────────────

/**
 * Dos itens sinalizados só interessam os gêneros (para os pesos), o título (para
 * a prateleira "Porque você gostou de…") e os campos do card (para "Minha
 * lista"). A relação `episodios` saiu daqui junto com `urlDub`/`urlLeg` do
 * payload: era uma query inteira para produzir dois booleanos que ninguém mais
 * lê.
 */
const selecaoSinalFilme = {
  id: true, titulo: true, poster: true, background: true, logo: true,
  generos: { select: { generoId: true } },
} as const;

const selecaoSinalSerie = {
  id: true, titulo: true, poster: true, background: true, logo: true, tipo: true,
  generos: { select: { generoId: true } },
} as const;

interface MidiaSinal {
  id: string;
  titulo: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
  tipo: RecommendationKind;
  generoIds: number[];
}

function keyFor(conteudoId: string, conteudoTipo: string) {
  return `${conteudoTipo === "filme" ? "filme" : "serie"}:${conteudoId}`;
}

function normalizeSeriesType(tipo: string): RecommendationKind {
  return tipo === "anime" || tipo === "desenho" ? tipo : "serie";
}

function toCard(item: { id: string; tipo: RecommendationKind; titulo: string; poster: string | null; background: string | null; logo: string | null }): RecommendationCard {
  return {
    id: item.id,
    tipo: item.tipo,
    titulo: item.titulo,
    poster: item.poster,
    background: item.background,
    logo: item.logo,
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

  const [signalFilms, signalSeries, pool] = await Promise.all([
    signalFilmIds.length
      ? prisma.filme.findMany({ where: { id: { in: signalFilmIds } }, select: selecaoSinalFilme })
      : Promise.resolve([]),
    signalSeriesIds.length
      ? prisma.serie.findMany({ where: { id: { in: signalSeriesIds } }, select: selecaoSinalSerie })
      : Promise.resolve([]),
    getPoolCompartilhado(),
  ]);

  const signalMedia = new Map<string, MidiaSinal>();
  for (const row of signalFilms) {
    signalMedia.set(`filme:${row.id}`, {
      id: row.id, titulo: row.titulo, poster: row.poster, background: row.background, logo: row.logo,
      tipo: "filme", generoIds: row.generos.map((g) => g.generoId),
    });
  }
  for (const row of signalSeries) {
    signalMedia.set(`serie:${row.id}`, {
      id: row.id, titulo: row.titulo, poster: row.poster, background: row.background, logo: row.logo,
      tipo: normalizeSeriesType(row.tipo), generoIds: row.generos.map((g) => g.generoId),
    });
  }

  const genreWeights = new Map<number, number>();
  let filmAffinity = 0;
  let seriesAffinity = 0;
  for (const [key, signal] of signals) {
    const media = signalMedia.get(key);
    if (!media) continue;
    const genreDelta = signal.source === "dislike" ? -1.5 : Math.min(5, signal.weight);
    for (const generoId of media.generoIds) {
      genreWeights.set(generoId, (genreWeights.get(generoId) ?? 0) + genreDelta);
    }
    if (signal.weight > 0) {
      if (key.startsWith("filme:")) filmAffinity += signal.weight;
      else seriesAffinity += signal.weight;
    }
  }

  // A exclusão que antes era `notIn` no SQL. Mesmo resultado, feita sobre o
  // pool compartilhado — é o que permite reaproveitá-lo entre usuários.
  // O corte em 180 por tipo reproduz o `take` que vinha depois do `notIn`: o
  // conjunto de candidatos fica idêntico ao da versão que consultava o banco a
  // cada visita, e as prateleiras entregam os mesmos títulos.
  const idsFilme = new Set(signalFilmIds);
  const idsSerie = new Set(signalSeriesIds);
  const candidatos = [
    ...pool.filmes.filter((item) => !idsFilme.has(item.id)).slice(0, CANDIDATOS_POR_TIPO),
    ...pool.series.filter((item) => !idsSerie.has(item.id)).slice(0, CANDIDATOS_POR_TIPO),
  ];

  const anoAtual = new Date().getFullYear();
  const affinityTotal = filmAffinity + seriesAffinity;
  const score = (item: PoolItem) => {
    const genreScore = item.generoIds.reduce((total, generoId) => total + (genreWeights.get(generoId) ?? 0), 0);
    const quality = (item.nota ?? 0) * 0.3;
    const popularity = Math.log10(Math.max(1, item.popularidade ?? 1)) * 0.8;
    const affinity = affinityTotal > 0
      ? (item.tipo === "filme" ? filmAffinity : seriesAffinity) / affinityTotal
      : 0.5;
    const freshness = item.ano && item.ano >= anoAtual - 2 ? 0.8 : 0;
    return genreScore + quality + popularity + affinity * 2 + freshness;
  };

  const ranked = candidatos
    .map((item) => ({ item, score: score(item), card: toCard(item) }))
    .sort((a, b) => b.score - a.score);

  const rows: RecommendationRow[] = [];
  const usedAcrossRows = new Set<string>();
  const cardKey = (card: RecommendationCard) => `${card.tipo}:${card.id}`;
  const takeUnseen = (cards: RecommendationCard[], limit: number) => {
    const selected: RecommendationCard[] = [];
    const selectedKeys = new Set<string>();
    for (const card of cards) {
      const key = cardKey(card);
      if (usedAcrossRows.has(key) || selectedKeys.has(key)) continue;
      selectedKeys.add(key);
      selected.push(card);
      if (selected.length >= limit) break;
    }
    return selected;
  };
  const reserve = (cards: RecommendationCard[]) => cards.forEach((card) => usedAcrossRows.add(cardKey(card)));

  const personalized = takeUnseen(ranked.map((entry) => entry.card), 24);
  if (personalized.length >= 6) {
    reserve(personalized);
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
    const seedGenres = new Set<number>(seed?.generoIds ?? []);
    const similar = takeUnseen(ranked
      .filter((entry) => entry.item.generoIds.some((generoId) => seedGenres.has(generoId)))
      .map((entry) => entry.card), 20);
    if (seed?.titulo && similar.length >= 6) {
      reserve(similar);
      rows.push({ id: "because-seed", titulo: `Porque você gostou de ${seed.titulo}`, items: similar });
    }
  }

  const watchlistCards = watchlist
    .map((item) => {
      const media = signalMedia.get(keyFor(item.conteudoId, item.conteudoTipo));
      return media ? toCard(media) : null;
    })
    .filter(Boolean) as RecommendationCard[];
  const uniqueWatchlistCards = takeUnseen(watchlistCards, 24);
  if (uniqueWatchlistCards.length > 0) {
    reserve(uniqueWatchlistCards);
    rows.push({ id: "my-list", titulo: "Minha lista", items: uniqueWatchlistCards });
  }

  const excludedAnimeTitles = new Set<string>(ANIME_HOME_EXCLUSIONS);
  const anime = takeUnseen(ranked
    .filter((entry) => entry.card.tipo === "anime" && !excludedAnimeTitles.has(entry.card.titulo))
    .map((entry) => entry.card), 20);
  if (anime.length >= 6) {
    reserve(anime);
    rows.push({ id: "anime-radar", titulo: "Animes para entrar no seu radar", items: anime });
  }

  const dubbed = takeUnseen(ranked.filter((entry) => entry.item.temDub).map((entry) => entry.card), 20);
  if (dubbed.length >= 6) {
    reserve(dubbed);
    rows.push({ id: "dubbed", titulo: "Dublados para maratonar", items: dubbed });
  }

  return { rows, signalCount: signals.size };
}
