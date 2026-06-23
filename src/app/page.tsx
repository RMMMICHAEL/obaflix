import { HeroSlider } from "@/components/ui/HeroSlider";
import { ContentRow } from "@/components/ui/ContentRow";
import { prisma } from "@/lib/prisma";
import {
  getTrending, getPopularMovies, getPopularTV,
  getTopRatedMovies, getTopRatedTV, getNowPlayingMovies,
  discoverMovies, discoverTV, imgUrl, TmdbItem,
} from "@/lib/tmdb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ── Genre map (TMDB IDs) ───────────────────────────────────────────────────
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
];

type CardItem = {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  ano: number | null;
  nota: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
};

// Convert DB row to card
function dbToCard(r: any, tipo: CardItem["tipo"]): CardItem {
  return {
    id: r.id, tipo,
    titulo: r.titulo, poster: r.poster,
    ano: r.ano, nota: r.nota,
    urlDub: r.urlDub ?? null, urlLeg: r.urlLeg ?? null,
  };
}

// Convert TMDB item → card using DB map (keyed by tmdbId)
function tmdbToCard(
  item: TmdbItem,
  dbMap: Map<string, any>,
  fallbackTipo: CardItem["tipo"],
): CardItem | null {
  const tmdbId = String(item.id);
  const db = dbMap.get(tmdbId);
  const tipo: CardItem["tipo"] =
    db?.tipo === "anime" ? "anime"
    : db?.tipo === "desenho" ? "desenho"
    : item.media_type === "tv" ? "serie"
    : fallbackTipo;

  // Use DB poster if available, otherwise TMDB poster
  const poster = db?.poster ?? item.poster_path ?? null;
  const ano = db?.ano ?? (Number((item.release_date ?? item.first_air_date ?? "").slice(0, 4)) || null);
  const nota = db?.nota ?? item.vote_average ?? null;
  const titulo = db?.titulo ?? item.title ?? item.name ?? "";

  if (!db) {
    // Item not in our DB — still show it without play link
    return {
      id: `tmdb-${tmdbId}`,
      tipo,
      titulo,
      poster,
      ano,
      nota,
      urlDub: null,
      urlLeg: null,
    };
  }

  return {
    id: db.id,
    tipo,
    titulo,
    poster,
    ano,
    nota,
    urlDub: db.urlDub ?? null,
    urlLeg: db.urlLeg ?? null,
  };
}

const selDB = { id: true, tmdbId: true, titulo: true, poster: true, ano: true, nota: true } as const;
const selFilme = { ...selDB, urlDub: true, urlLeg: true } as const;
const selSerie  = { ...selDB, tipo: true } as const;

export default async function HomePage() {
  // ── Fetch TMDB lists + DB in parallel ──────────────────────────────────
  const [
    tmdbTrending,
    tmdbPopMovies,
    tmdbPopTV,
    tmdbTopMovies,
    tmdbTopTV,
    tmdbNowPlaying,
    tmdbAnime,
    tmdbAcao,
    tmdbTerror,
    tmdbFiccao,
    // DB sections
    dbRecFilmes,
    dbRecSeries,
    dbAnimes,
    dbDesenhos,
    ...dbGeneroFilmes
  ] = await Promise.all([
    getTrending("week"),
    getPopularMovies(),
    getPopularTV(),
    getTopRatedMovies(),
    getTopRatedTV(),
    getNowPlayingMovies(),
    discoverTV({ with_original_language: "ja", with_genres: "16", sort_by: "vote_average.desc", "vote_count.gte": 200 }),
    discoverMovies({ with_genres: "28", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "27", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "878", sort_by: "popularity.desc" }),
    // Our DB
    prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 24, select: selFilme }),
    prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 24, select: selSerie }),
    prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { nota: "desc" }, take: 24, select: selSerie }),
    prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { nota: "desc" }, take: 24, select: selSerie }),
    // Genre rows (filmes)
    ...GENEROS.map((g) =>
      prisma.filme.findMany({
        where: { generos: { some: { generoId: g.id } } },
        orderBy: { nota: "desc" },
        take: 24,
        select: selFilme,
      })
    ),
  ]);

  // ── Build tmdbId→DB maps for cross-referencing ─────────────────────────
  const allTmdbIds = [
    ...(tmdbTrending?.results ?? []),
    ...(tmdbPopMovies?.results ?? []),
    ...(tmdbPopTV?.results ?? []),
    ...(tmdbTopMovies?.results ?? []),
    ...(tmdbTopTV?.results ?? []),
    ...(tmdbNowPlaying?.results ?? []),
    ...(tmdbAnime?.results ?? []),
    ...(tmdbAcao?.results ?? []),
    ...(tmdbTerror?.results ?? []),
    ...(tmdbFiccao?.results ?? []),
  ].map((i) => String(i.id));

  const [dbFilmesMap_raw, dbSeriesMap_raw] = await Promise.all([
    prisma.filme.findMany({
      where: { tmdbId: { in: allTmdbIds } },
      select: selFilme,
    }),
    prisma.serie.findMany({
      where: { tmdbId: { in: allTmdbIds } },
      select: selSerie,
    }),
  ]);

  const filmeMap = new Map(dbFilmesMap_raw.map((f) => [f.tmdbId!, f]));
  const serieMap = new Map(dbSeriesMap_raw.map((s) => [s.tmdbId!, s]));

  function mergeMap(item: TmdbItem): Map<string, any> {
    return item.media_type === "tv" ? serieMap : filmeMap;
  }

  // ── Convert TMDB lists to cards ─────────────────────────────────────────
  function tmdbList(items: TmdbItem[], defaultTipo: CardItem["tipo"]): CardItem[] {
    return items
      .map((i) => tmdbToCard(i, mergeMap(i), defaultTipo))
      .filter(Boolean) as CardItem[];
  }

  const trending   = tmdbList(tmdbTrending?.results ?? [], "filme").slice(0, 20);
  const popMovies  = tmdbList(tmdbPopMovies?.results ?? [], "filme").slice(0, 24);
  const popTV      = tmdbList(tmdbPopTV?.results ?? [], "serie").slice(0, 24);
  const topMovies  = tmdbList(tmdbTopMovies?.results ?? [], "filme").slice(0, 24);
  const topTV      = tmdbList(tmdbTopTV?.results ?? [], "serie").slice(0, 24);
  const nowPlaying = tmdbList(tmdbNowPlaying?.results ?? [], "filme").slice(0, 24);
  const animeList  = tmdbList(tmdbAnime?.results ?? [], "anime").slice(0, 24);
  const acaoList   = tmdbList(tmdbAcao?.results ?? [], "filme").slice(0, 24);
  const terrorList = tmdbList(tmdbTerror?.results ?? [], "filme").slice(0, 24);
  const ficcaoList = tmdbList(tmdbFiccao?.results ?? [], "filme").slice(0, 24);

  // ── Hero: trending items with backdrop ─────────────────────────────────
  const heroRaw = (tmdbTrending?.results ?? []).slice(0, 8);
  const heroItems = heroRaw.map((item) => {
    const db = mergeMap(item).get(String(item.id));
    return {
      id: db?.id ?? `tmdb-${item.id}`,
      tipo: item.media_type === "tv" ? "serie" : "filme",
      titulo: db?.titulo ?? item.title ?? item.name ?? "",
      sinopse: item.overview ?? null,
      background: item.backdrop_path
        ? imgUrl(item.backdrop_path, "original")
        : db?.poster ?? null,
    };
  });

  // ── DB genre rows ───────────────────────────────────────────────────────
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

      <div className="mt-6 space-y-2">
        {/* TMDB-powered sections */}
        {trending.length > 0 && (
          <ContentRow titulo="🔥 Em Alta Esta Semana" items={trending} />
        )}
        {nowPlaying.length > 0 && (
          <ContentRow titulo="🎬 Em Cartaz nos Cinemas" items={nowPlaying} />
        )}
        {popMovies.length > 0 && (
          <ContentRow titulo="🎥 Filmes Mais Populares" items={popMovies} />
        )}
        {popTV.length > 0 && (
          <ContentRow titulo="📺 Séries Mais Populares" items={popTV} />
        )}
        {topMovies.length > 0 && (
          <ContentRow titulo="⭐ Filmes Melhor Avaliados" items={topMovies} />
        )}
        {topTV.length > 0 && (
          <ContentRow titulo="⭐ Séries Melhor Avaliadas" items={topTV} />
        )}

        {/* Our DB sections */}
        {dbRecFilmes.length > 0 && (
          <ContentRow titulo="🆕 Adicionados Recentemente — Filmes" items={dbRecFilmes.map((f) => dbToCard(f, "filme"))} />
        )}
        {dbRecSeries.length > 0 && (
          <ContentRow titulo="🆕 Adicionados Recentemente — Séries" items={dbRecSeries.map((s) => dbToCard(s, "serie"))} />
        )}

        {/* TMDB genre rows */}
        {acaoList.length > 0 && (
          <ContentRow titulo="💥 Ação" items={acaoList} />
        )}
        {terrorList.length > 0 && (
          <ContentRow titulo="👻 Terror" items={terrorList} />
        )}
        {ficcaoList.length > 0 && (
          <ContentRow titulo="🚀 Ficção Científica" items={ficcaoList} />
        )}
        {animeList.length > 0 && (
          <ContentRow titulo="🎌 Animes" items={animeList} />
        )}
        {dbAnimes.length > 0 && (
          <ContentRow titulo="🎌 Animes no Catálogo" items={dbAnimes.map((s) => dbToCard(s, "anime"))} />
        )}
        {dbDesenhos.length > 0 && (
          <ContentRow titulo="🖼️ Desenhos" items={dbDesenhos.map((s) => dbToCard(s, "desenho"))} />
        )}

        {/* DB genre rows */}
        {generoRows.map((g) =>
          g.filmes.length > 0 ? (
            <ContentRow key={g.id} titulo={g.nome} items={g.filmes} />
          ) : null
        )}
      </div>
    </div>
  );
}
