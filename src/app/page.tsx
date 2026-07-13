import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { RankRow } from "@/components/ui/RankRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { EpisodioRecenteRow } from "@/components/ui/EpisodioRecenteRow";
import { CollectionsRow } from "@/components/ui/CollectionsRow";
import { prisma } from "@/lib/prisma";
import {
  getTrending, getPopularMovies, getPopularTV,
  getTopRatedMovies, getTopRatedTV,
  discoverMovies, discoverTV,
  getMovieVideos, getTVVideos,
  imgUrl, pickTrailer, TmdbItem,
} from "@/lib/tmdb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

// Janela de 30 dias para o ranking de visualizações
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

// createdAt + logo incluídos nas queries
const selDB = { id: true, tmdbId: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true, createdAt: true } as const;
const selFilme = { ...selDB, urlDub: true, urlLeg: true } as const;
const selSerie  = { ...selDB, tipo: true } as const;

export default async function HomePage() {
  const [
    tmdbTrending,
    tmdbPopMovies,
    tmdbPopTV,
    tmdbTopMovies,
    tmdbTopTV,
    tmdbAnime,
    tmdbComedia,
    tmdbTerror,
    tmdbFiccao,
    tmdbRomance,
    tmdbCrime,
    dbRecFilmes,
    dbRecSeries,
    dbAnimes,
    dbDesenhos,
    // Top 10 por visualizações + fallback por nota
    top10FilmesHistory,
    top10SeriesHistory,
    dbTop10FilmesFallback,
    dbTop10SeriesFallback,
    dbEpsRecentes,
    ...dbGeneroFilmes
  ] = await Promise.all([
    getTrending("week"),
    getPopularMovies(),
    getPopularTV(),
    getTopRatedMovies(),
    getTopRatedTV(),
    discoverTV({ with_original_language: "ja", with_genres: "16", sort_by: "vote_average.desc", "vote_count.gte": 200 }),
    discoverMovies({ with_genres: "35", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "27", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "878", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "10749", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "80", sort_by: "popularity.desc" }),
    // Novos do banco (últimos adicionados)
    prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 24, select: selFilme }),
    prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 24, select: selSerie }),
    prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { nota: "desc" }, take: 24, select: selSerie }),
    prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { nota: "desc" }, take: 24, select: selSerie }),
    // Top 10 por visualizações — últimos 30 dias (atualiza sozinho com o uso)
    // Só conta "view" genuína: ignora placeholders de fila (queued) e starts
    // com poucos segundos assistidos, que não representam interesse real.
    prisma.watchHistory.groupBy({
      by: ["filmeId"],
      where: {
        filmeId: { not: null },
        updatedAt: { gte: THIRTY_DAYS_AGO },
        queued: false,
        progressoSeg: { gte: 60 },
      },
      _count: { userId: true },
      orderBy: { _count: { userId: "desc" } },
      take: 15,
    }),
    // Séries: uma linha por episódio assistido (userId, conteudoId, episodioId)
    // é a unique key — então contar linhas conta "episódios vistos", não
    // "pessoas que assistiram". Agrupamos por (serieId, userId) primeiro para
    // colapsar em pares distintos e só então contamos quantos usuários únicos
    // cada série teve, senão uma maratona de 1 pessoa parece "mais popular"
    // que uma série vista por vários usuários uma vez só.
    prisma.watchHistory.groupBy({
      by: ["serieId", "userId"],
      where: {
        serieId: { not: null },
        updatedAt: { gte: THIRTY_DAYS_AGO },
        queued: false,
        progressoSeg: { gte: 60 },
      },
    }).then((rows) => {
      const viewerCounts = new Map<string, number>();
      for (const row of rows) {
        const id = row.serieId!;
        viewerCounts.set(id, (viewerCounts.get(id) ?? 0) + 1);
      }
      return [...viewerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([serieId, count]) => ({ serieId, _count: { userId: count } }));
    }),
    // Fallback por nota (usado quando não há histórico suficiente)
    prisma.filme.findMany({ orderBy: { nota: "desc" }, take: 10, select: selFilme }),
    prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { nota: "desc" }, take: 10, select: selSerie }),
    // Episódios recentes — últimos 24 adicionados com info da série
    prisma.episodio.findMany({
      orderBy: { createdAt: "desc" },
      take: 24,
      select: {
        id: true, serieId: true, titulo: true, thumbnail: true,
        temporada: true, numeroEp: true, urlDub: true, urlLeg: true, createdAt: true,
        serie: { select: { titulo: true, poster: true, tipo: true } },
      },
    }),
    // Gêneros por banco
    ...["28","35","27","10749","878","18","16","80","53","12","99","9648"].map((gId) =>
      prisma.filme.findMany({
        where: { generos: { some: { generoId: Number(gId) } } },
        orderBy: { nota: "desc" },
        take: 24,
        select: selFilme,
      })
    ),
  ]);

  const GENEROS = [
    { id: 28,    nome: "Ação" },
    { id: 35,    nome: "Comédia" },
    { id: 27,    nome: "Terror" },
    { id: 10749, nome: "Romance" },
    { id: 878,   nome: "Ficção Científica" },
    { id: 18,    nome: "Drama" },
    { id: 16,    nome: "Animação" },
    { id: 80,    nome: "Crime" },
    { id: 53,    nome: "Thriller" },
    { id: 12,    nome: "Aventura" },
    { id: 99,    nome: "Documentários" },
    { id: 9648,  nome: "Mistério" },
  ];

  const heroRaw = (tmdbTrending?.results ?? []).slice(0, 8);

  const allTmdbIds = [
    ...(tmdbTrending?.results ?? []),
    ...(tmdbPopMovies?.results ?? []),
    ...(tmdbPopTV?.results ?? []),
    ...(tmdbTopMovies?.results ?? []),
    ...(tmdbTopTV?.results ?? []),
    ...(tmdbAnime?.results ?? []),
    ...(tmdbComedia?.results ?? []),
    ...(tmdbTerror?.results ?? []),
    ...(tmdbFiccao?.results ?? []),
    ...(tmdbRomance?.results ?? []),
    ...(tmdbCrime?.results ?? []),
  ].map((i) => String(i.id));

  // Extrai IDs ordenados pelo ranking de visualizações
  const top10FilmesIds = (top10FilmesHistory as any[])
    .map((r) => r.filmeId as string | null)
    .filter((id): id is string => id !== null);
  const top10SeriesIds = (top10SeriesHistory as any[])
    .map((r) => r.serieId as string | null)
    .filter((id): id is string => id !== null);

  const [[dbFilmesMap_raw, dbSeriesMap_raw, top10FilmesDb, top10SeriesDb], heroTrailerResults] = await Promise.all([
    Promise.all([
      prisma.filme.findMany({ where: { tmdbId: { in: allTmdbIds } }, select: selFilme }),
      prisma.serie.findMany({ where: { tmdbId: { in: allTmdbIds } }, select: selSerie }),
      // Busca detalhes dos filmes/séries mais assistidos (para montar os cards)
      top10FilmesIds.length > 0
        ? prisma.filme.findMany({ where: { id: { in: top10FilmesIds } }, select: selFilme })
        : Promise.resolve([] as typeof dbTop10FilmesFallback),
      top10SeriesIds.length > 0
        ? prisma.serie.findMany({ where: { id: { in: top10SeriesIds }, tipo: "serie" }, select: selSerie })
        : Promise.resolve([] as typeof dbTop10SeriesFallback),
    ]),
    Promise.all(
      heroRaw.slice(0, 5).map((item: any) =>
        item.media_type === "tv" ? getTVVideos(item.id) : getMovieVideos(item.id)
      )
    ),
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
  const popMovies   = tmdbList(tmdbPopMovies?.results ?? [], "filme").slice(0, 24);
  const popTV       = tmdbList(tmdbPopTV?.results ?? [], "serie").slice(0, 24);
  const topMovies   = tmdbList(tmdbTopMovies?.results ?? [], "filme").slice(0, 24);
  const topTV       = tmdbList(tmdbTopTV?.results ?? [], "serie").slice(0, 24);
  const animeList   = tmdbList(tmdbAnime?.results ?? [], "anime").slice(0, 24);
  const comediaList = tmdbList(tmdbComedia?.results ?? [], "filme").slice(0, 24);
  const terrorList  = tmdbList(tmdbTerror?.results ?? [], "filme").slice(0, 24);
  const ficcaoList  = tmdbList(tmdbFiccao?.results ?? [], "filme").slice(0, 24);
  const romanceList = tmdbList(tmdbRomance?.results ?? [], "filme").slice(0, 24);
  const crimeList   = tmdbList(tmdbCrime?.results ?? [], "filme").slice(0, 24);

  // Constrói Top 10 priorizando visualizações; preenche com nota se faltar itens
  function buildTop10Cards(
    historyIds: string[],
    historyData: any[],
    fallback: any[],
    tipo: CardItem["tipo"],
  ): CardItem[] {
    if (historyIds.length === 0) return fallback.slice(0, 10).map((f) => dbToCard(f, tipo));
    const byId = new Map(historyData.map((d) => [d.id, d]));
    const ranked = historyIds.map((id) => byId.get(id)).filter(Boolean) as any[];
    if (ranked.length < 10) {
      const seen = new Set(ranked.map((f) => f.id));
      const extra = fallback.filter((f) => !seen.has(f.id)).slice(0, 10 - ranked.length);
      return [...ranked, ...extra].map((f) => dbToCard(f, tipo));
    }
    return ranked.slice(0, 10).map((f) => dbToCard(f, tipo));
  }

  const top10FilmesCards = buildTop10Cards(top10FilmesIds, top10FilmesDb, dbTop10FilmesFallback, "filme");
  const top10SeriesCards = buildTop10Cards(top10SeriesIds, top10SeriesDb, dbTop10SeriesFallback, "serie");

  const heroItems = heroRaw.map((item: any, i: number) => {
    const db = mergeMap(item).get(String(item.id));
    const trailerVideos = i < 5 ? (heroTrailerResults[i] as any) : null;
    const trailer = pickTrailer(trailerVideos?.results);
    return {
      id: db?.id ?? `tmdb-${item.id}`,
      tipo: item.media_type === "tv" ? "serie" : "filme",
      titulo: db?.titulo ?? item.title ?? item.name ?? "",
      sinopse: item.overview ?? null,
      background: item.backdrop_path ? imgUrl(item.backdrop_path, "original") : db?.poster ?? null,
      trailerKey: trailer?.key ?? null,
    };
  });

  const epsRecentesItems = (dbEpsRecentes as any[]).map((e) => ({
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

  const generoRows = GENEROS.map((g, i) => ({
    ...g,
    filmes: (dbGeneroFilmes[i] ?? []).map((f) => dbToCard(f, "filme")),
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

      <div className="mt-3">
        {/* Continuar Assistindo */}
        <ContinuarAssistindo />

        {/* Em Alta */}
        {trending.length > 0 && (
          <LandscapeRow titulo="Em Alta" items={trending} />
        )}

        {/* Coleções */}
        <CollectionsRow />

        {/* Top 10 Filmes — baseado em histórico real de visualizações */}
        {top10FilmesCards.length > 0 && (
          <RankRow titulo="Top 10 Filmes" items={top10FilmesCards} verTodosHref="/filmes" />
        )}

        {/* Novos Filmes */}
        {dbRecFilmes.length > 0 && (
          <LandscapeRow
            titulo="Novos Filmes"
            items={dbRecFilmes.map((f) => dbToCard(f, "filme"))}
            verTodosHref="/filmes"
          />
        )}

        {/* Filmes Populares */}
        {popMovies.length > 0 && (
          <LandscapeRow titulo="Filmes Populares" items={popMovies} verTodosHref="/filmes" />
        )}

        {/* Episódios Recentes */}
        <EpisodioRecenteRow titulo="Episódios Recentes" items={epsRecentesItems} />

        {/* Top 10 Séries — baseado em histórico real de visualizações */}
        {top10SeriesCards.length > 0 && (
          <RankRow titulo="Top 10 Séries" items={top10SeriesCards} verTodosHref="/series" />
        )}

        {/* Novas Séries */}
        {dbRecSeries.length > 0 && (
          <LandscapeRow
            titulo="Novas Séries"
            items={dbRecSeries.map((s) => dbToCard(s, "serie"))}
            verTodosHref="/series"
          />
        )}

        {/* Séries Populares */}
        {popTV.length > 0 && (
          <LandscapeRow titulo="Séries Populares" items={popTV} verTodosHref="/series" />
        )}

        {/* Animes */}
        {animeList.length > 0 && (
          <LandscapeRow titulo="Animes" items={animeList} verTodosHref="/animes" />
        )}

        {/* Desenhos */}
        {dbDesenhos.length > 0 && (
          <LandscapeRow
            titulo="Desenhos Animados"
            items={dbDesenhos.map((s) => dbToCard(s, "desenho"))}
            verTodosHref="/desenhos"
          />
        )}

        {/* Gêneros */}
        {comediaList.length > 0 && <LandscapeRow titulo="Comédia" items={comediaList} verTodosHref="/genero/35" />}
        {terrorList.length > 0   && <LandscapeRow titulo="Terror"  items={terrorList}  verTodosHref="/genero/27" />}
        {ficcaoList.length > 0   && <LandscapeRow titulo="Ficção Científica" items={ficcaoList} verTodosHref="/genero/878" />}
        {romanceList.length > 0  && <LandscapeRow titulo="Romance" items={romanceList} verTodosHref="/genero/10749" />}
        {crimeList.length > 0    && <LandscapeRow titulo="Crime"   items={crimeList}   verTodosHref="/genero/80" />}
      </div>
    </div>
  );
}
