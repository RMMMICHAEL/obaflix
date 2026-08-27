import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { LazyRow } from "@/components/ui/LazyRow";
import { RankRow } from "@/components/ui/RankRow";
import { Top10Band } from "@/components/ui/Top10Band";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { EpisodioRecenteRow } from "@/components/ui/EpisodioRecenteRow";
import { PersonalizedRows } from "@/components/ui/PersonalizedRows";
import { prisma } from "@/lib/prisma";
import { ANIME_HOME_EXCLUSIONS } from "@/lib/editorialCatalog";
import {
  getTrending,
  imgUrl, TmdbItem,
} from "@/lib/tmdb";

export const revalidate = 300;

// Série/filme adicionado nos últimos 3 dias → "Recém Adicionado"
const NEW_SERIE_MS = 3 * 24 * 60 * 60 * 1000;
// Episódio adicionado nas últimas 48h → "Novo Episódio"
const NEW_EP_MS = 48 * 60 * 60 * 1000;

function isRecent(date?: Date | null): boolean {
  if (!date) return false;
  return Date.now() - new Date(date).getTime() < NEW_SERIE_MS;
}
function isEpRecent(date?: Date | null): boolean {
  if (!date) return false;
  return Date.now() - new Date(date).getTime() < NEW_EP_MS;
}

type CardItem = {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  background?: string | null;
  logo?: string | null;
  ano: number | null;
  nota: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  isNew?: boolean;
};

function dbToCard(r: any, tipo: CardItem["tipo"]): CardItem {
  return {
    id: r.id, tipo,
    titulo: r.titulo, poster: r.poster,
    background: r.background ?? null,
    logo: r.logo ?? null,
    ano: r.ano, nota: r.nota,
    urlDub: r.urlDub ?? null, urlLeg: r.urlLeg ?? null,
    isNew: isRecent(r.createdAt),
  };
}

function tmdbToCard(item: TmdbItem, dbMap: Map<string, any>, fallbackTipo: CardItem["tipo"]): CardItem | null {
  const tmdbId = String(item.id);
  const db = dbMap.get(tmdbId);
  if (!db) return null;
  const tipo: CardItem["tipo"] =
    db?.tipo === "anime" ? "anime"
    : db?.tipo === "desenho" ? "desenho"
    : item.media_type === "tv" ? "serie"
    : fallbackTipo;
  return {
    id: db.id, tipo,
    titulo: db?.titulo ?? item.title ?? item.name ?? "",
    poster: db?.poster ?? item.poster_path ?? null,
    background: db?.background ?? item.backdrop_path ?? null,
    logo: db?.logo ?? null,
    ano: db?.ano ?? (Number((item.release_date ?? item.first_air_date ?? "").slice(0, 4)) || null),
    nota: db?.nota ?? item.vote_average ?? null,
    urlDub: db.urlDub ?? null, urlLeg: db.urlLeg ?? null,
    isNew: isRecent(db.createdAt),
  };
}

// createdAt + logo incluídos nas queries
const selDB = { id: true, tmdbId: true, titulo: true, poster: true, background: true, logo: true, sinopse: true, ano: true, nota: true, createdAt: true } as const;
const selFilme = { ...selDB, urlDub: true, urlLeg: true } as const;
const selSerie  = { ...selDB, tipo: true } as const;

export default async function HomePage() {
  const [
    tmdbTrending,
    dbRecFilmes,
    dbRecSeries,
    dbAnimes,
    // Populares (Top 10 + linhas "Populares") — direto do catálogo local
    // ordenado por popularidade real do TMDB, sem depender de cruzar com
    // listas ao vivo do TMDB (que descartavam a maioria dos itens por falta
    // de correspondência no banco).
    dbPopFilmes,
    dbPopSeries,
    dbRankFilmes,
    dbRankSeries,
    dbTopRatedFilmes,
    dbTopRatedSeries,
    dbEpsRecentes,
  ] = await Promise.all([
    getTrending("week"),
    // Novos do banco (últimos adicionados)
    prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 24, select: selFilme }),
    prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 24, select: selSerie }),
    prisma.serie.findMany({
      where: { tipo: "anime", titulo: { notIn: [...ANIME_HOME_EXCLUSIONS] } },
      orderBy: { popularidade: { sort: "desc", nulls: "last" } },
      take: 24,
      select: selSerie,
    }),
    prisma.filme.findMany({ orderBy: { popularidade: { sort: "desc", nulls: "last" } }, take: 24, select: selFilme }),
    prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { popularidade: { sort: "desc", nulls: "last" } }, take: 24, select: selSerie }),
    // Top 10 — mesma fonte de "Filmes/Séries Populares" de /melhores:
    // o popularRank que os scripts de sync gravam no catálogo. Antes vinha do
    // top250 (curadoria fixa do IMDb), que é outra lista e outra intenção.
    prisma.filme.findMany({ where: { popularRank: { not: null } }, orderBy: { popularRank: "asc" }, take: 10, select: selFilme }),
    prisma.serie.findMany({ where: { tipo: "serie", popularRank: { not: null } }, orderBy: { popularRank: "asc" }, take: 10, select: selSerie }),
    // Mais bem avaliados — nota do TMDB, distinto de popularidade (quem mais
    // assistiu) e do top250 (curadoria fixa). Sem um mínimo de votos a lista
    // encheria de títulos obscuros com nota 10 e um punhado de votos.
    prisma.filme.findMany({
      where: { nota: { gte: 7 } },
      orderBy: { nota: { sort: "desc", nulls: "last" } },
      take: 24,
      select: selFilme,
    }),
    prisma.serie.findMany({
      where: { tipo: "serie", nota: { gte: 7 } },
      orderBy: { nota: { sort: "desc", nulls: "last" } },
      take: 24,
      select: selSerie,
    }),
    // Episódios recentes — últimos 24 adicionados com info da série
    prisma.episodio.findMany({
      orderBy: { createdAt: "desc" },
      take: 24,
      select: {
        id: true, serieId: true, titulo: true, thumbnail: true,
        temporada: true, numeroEp: true, urlDub: true, urlLeg: true, createdAt: true,
        serie: { select: { titulo: true, poster: true, tipo: true, createdAt: true } },
      },
    }),
    // Gêneros por banco
  ]);

  const heroRaw = (tmdbTrending?.results ?? []).slice(0, 8);

  const allTmdbIds = [
    ...(tmdbTrending?.results ?? []),
  ].map((i) => String(i.id));

  const [dbFilmesMap_raw, dbSeriesMap_raw] = await Promise.all([
    prisma.filme.findMany({ where: { tmdbId: { in: allTmdbIds } }, select: selFilme }),
    prisma.serie.findMany({ where: { tmdbId: { in: allTmdbIds } }, select: selSerie }),
  ]);

  const filmeMap = new Map(dbFilmesMap_raw.map((f) => [f.tmdbId!, f]));
  const serieMap = new Map(dbSeriesMap_raw.map((s) => [s.tmdbId!, s]));

  function mergeMap(item: TmdbItem): Map<string, any> {
    return item.media_type === "tv" ? serieMap : filmeMap;
  }

  function tmdbList(items: TmdbItem[], defaultTipo: CardItem["tipo"]): CardItem[] {
    return items.map((i) => tmdbToCard(i, mergeMap(i), defaultTipo)).filter(Boolean) as CardItem[];
  }

  const trending    = tmdbList(tmdbTrending?.results ?? [], "filme").slice(0, 20);

  // Populares e Top 10 vêm direto do catálogo local ordenado por popularidade
  // real do TMDB — mesma lógica para filmes e séries, sem itens descartados
  // por falta de correspondência com listas ao vivo do TMDB.
  const popMovies = dbPopFilmes.map((f) => dbToCard(f, "filme"));
  const popTV     = dbPopSeries.map((s) => dbToCard(s, "serie"));
  const top10FilmesCards = (dbRankFilmes.length ? dbRankFilmes : dbPopFilmes.slice(0, 10)).map((item) => dbToCard(item, "filme"));
  const top10SeriesCards = (dbRankSeries.length ? dbRankSeries : dbPopSeries.slice(0, 10)).map((item) => dbToCard(item, "serie"));
  const animeCards = dbAnimes.map((anime) => dbToCard(anime, "anime"));

  const tmdbHeroItems = heroRaw.map((item: any) => {
    const db = mergeMap(item).get(String(item.id));
    if (!db) return null;
    return {
      id: db.id,
      tipo: item.media_type === "tv" ? "serie" : "filme",
      titulo: db.titulo ?? item.title ?? item.name ?? "",
      sinopse: item.overview ?? db.sinopse ?? null,
      background: db.background ?? (item.backdrop_path ? imgUrl(item.backdrop_path, "original") : db.poster ?? null),
      trailerKey: null,
    };
  }).filter(Boolean);

  // A vitrine continua funcional mesmo quando o TMDB estiver lento ou fora do ar.
  const fallbackHeroItems = [
    ...dbPopFilmes.slice(0, 4).map((item) => ({ ...item, tipo: "filme" as const })),
    ...dbPopSeries.slice(0, 4).map((item) => ({ ...item, tipo: "serie" as const })),
  ]
    .filter((item) => item.background || item.poster)
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      tipo: item.tipo,
      titulo: item.titulo,
      sinopse: item.sinopse ?? null,
      background: item.background ?? item.poster ?? null,
      trailerKey: null,
    }));

  const heroItems = tmdbHeroItems.length ? tmdbHeroItems : fallbackHeroItems;

  // Para uma série recém-importada, mostra apenas seu episódio mais avançado;
  // atualizações de séries antigas continuam aparecendo individualmente.
  const episodiosParaVitrine = (dbEpsRecentes as any[]).filter((ep, index, all) => {
    const serieNova = isRecent(ep.serie.createdAt) || String(ep.serieId).startsWith("sf_");
    if (!serieNova) return true;
    return !all.some((other) =>
      other.serieId === ep.serieId &&
      (other.temporada > ep.temporada ||
        (other.temporada === ep.temporada && other.numeroEp > ep.numeroEp)),
    );
  }).slice(0, 24);

  const epsRecentesItems = episodiosParaVitrine.map((e) => ({
    episodioId: e.id,
    serieId: e.serieId,
    titulo: e.titulo ?? null,
    serieTitulo: e.serie.titulo,
    poster: e.serie.poster ?? null,
    thumbnail: e.thumbnail ?? null,
    temporada: e.temporada,
    numeroEp: e.numeroEp,
    tipo: (e.serie.tipo ?? "serie") as "serie" | "anime" | "desenho",
    isNovoEpisodio: isEpRecent(e.createdAt),
    urlDub: e.urlDub ?? null,
    urlLeg: e.urlLeg ?? null,
  }));

  if (!dbRecFilmes.length && !trending.length) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-5xl font-black text-red-600 mb-3">OBAFLIX</h1>
          <p className="text-zinc-400">Configure o banco de dados e importe o catálogo para começar.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pb-16">
      <HeroSlider items={heroItems as any} />

      {/* Ordem por intencao decrescente: retomar o que ja comecou, depois o que
          esta em alta, depois descobrir por popularidade e nota. "Continuar
          Assistindo" estava na oitava posicao, atras de seis prateleiras — a
          acao de maior intencao exigia rolagem para ser encontrada. */}
      <div className="mt-3">
        <ContinuarAssistindo />

        {trending.length > 0 && (
          <LandscapeRow titulo="Em Alta" items={trending} />
        )}

        {/* Filmes */}
        {dbPopFilmes.length > 0 && (
          <LazyRow>
            <LandscapeRow titulo="Filmes Populares" items={dbPopFilmes.map((f) => dbToCard(f, "filme"))} verTodosHref="/filmes" />
          </LazyRow>
        )}

        {top10FilmesCards.length > 0 && (
          <Top10Band>
            <RankRow titulo="Top 10 Filmes de Hoje" items={top10FilmesCards} verTodosHref="/melhores" />
          </Top10Band>
        )}

        {dbTopRatedFilmes.length > 0 && (
          <LazyRow>
            <LandscapeRow titulo="Filmes Mais Bem Avaliados" items={dbTopRatedFilmes.map((f) => dbToCard(f, "filme"))} verTodosHref="/melhores" />
          </LazyRow>
        )}

        {/* Séries */}
        {dbPopSeries.length > 0 && (
          <LazyRow>
            <LandscapeRow titulo="Séries Populares" items={dbPopSeries.map((s2) => dbToCard(s2, "serie"))} verTodosHref="/series" />
          </LazyRow>
        )}

        {top10SeriesCards.length > 0 && (
          <LazyRow>
            <Top10Band>
              <RankRow titulo="Top 10 Séries de Hoje" items={top10SeriesCards} verTodosHref="/melhores" />
            </Top10Band>
          </LazyRow>
        )}

        {dbTopRatedSeries.length > 0 && (
          <LazyRow>
            <LandscapeRow titulo="Séries Mais Bem Avaliadas" items={dbTopRatedSeries.map((s2) => dbToCard(s2, "serie"))} verTodosHref="/melhores" />
          </LazyRow>
        )}

        {/* Novidades e categorias */}
        <LazyRow>
          <EpisodioRecenteRow titulo="Episódios Recentes" items={epsRecentesItems} />
        </LazyRow>

        {dbRecFilmes.length > 0 && (
          <LazyRow>
            <LandscapeRow titulo="Novos Filmes" items={dbRecFilmes.map((f) => dbToCard(f, "filme"))} verTodosHref="/filmes" />
          </LazyRow>
        )}

        {dbRecSeries.length > 0 && (
          <LazyRow>
            <LandscapeRow titulo="Novas Séries" items={dbRecSeries.map((s2) => dbToCard(s2, "serie"))} verTodosHref="/series" />
          </LazyRow>
        )}

        {animeCards.length > 0 && (
          <LazyRow>
            <LandscapeRow titulo="Animes" items={animeCards} verTodosHref="/animes" />
          </LazyRow>
        )}

        <PersonalizedRows />
      </div>
    </div>
  );
}
