import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { RankRow } from "@/components/ui/RankRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
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

// Content added within the last 14 days is flagged as "Recém Adicionado"
const NEW_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
function isRecent(date?: Date | null): boolean {
  if (!date) return false;
  return Date.now() - new Date(date).getTime() < NEW_THRESHOLD_MS;
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
    // Top 10 direto do banco — garante 10 itens (focado no catálogo brasileiro)
    dbTop10Filmes,
    dbTop10Series,
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
    // Top 10 do banco por nota — sem depender do TMDB airing today (era vazio por ser série americana)
    prisma.filme.findMany({ orderBy: { nota: "desc" }, take: 10, select: selFilme }),
    prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { nota: "desc" }, take: 10, select: selSerie }),
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

  const [[dbFilmesMap_raw, dbSeriesMap_raw], heroTrailerResults] = await Promise.all([
    Promise.all([
      prisma.filme.findMany({ where: { tmdbId: { in: allTmdbIds } }, select: selFilme }),
      prisma.serie.findMany({ where: { tmdbId: { in: allTmdbIds } }, select: selSerie }),
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

  // Top 10 direto do banco — sempre tem itens
  const top10FilmesCards = dbTop10Filmes.map((f) => dbToCard(f, "filme"));
  const top10SeriesCards = dbTop10Series.map((s) => dbToCard(s, "serie"));

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

        {/* Top 10 Filmes — direto do banco, sempre 10 itens */}
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

        {/* Filmes Populares (TMDB) */}
        {popMovies.length > 0 && (
          <LandscapeRow titulo="Filmes Populares" items={popMovies} verTodosHref="/filmes" />
        )}

        {/* Filmes Mais Bem Avaliados */}
        {topMovies.length > 0 && (
          <LandscapeRow titulo="Filmes Mais Bem Avaliados" items={topMovies} verTodosHref="/filmes" />
        )}

        {/* Séries Populares (TMDB) */}
        {popTV.length > 0 && (
          <LandscapeRow titulo="Séries Populares" items={popTV} verTodosHref="/series" />
        )}

        {/* Top 10 Séries — direto do banco, sempre 10 itens */}
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

        {/* Séries Mais Bem Avaliadas */}
        {topTV.length > 0 && (
          <LandscapeRow titulo="Séries Mais Bem Avaliadas" items={topTV} verTodosHref="/series" />
        )}

        {/* Animes */}
        {animeList.length > 0 && (
          <LandscapeRow titulo="Animes Populares" items={animeList} verTodosHref="/animes" />
        )}
        {dbAnimes.length > 0 && (
          <LandscapeRow
            titulo="Animes no Catálogo"
            items={dbAnimes.map((s) => dbToCard(s, "anime"))}
            verTodosHref="/animes"
          />
        )}

        {/* Desenhos */}
        {dbDesenhos.length > 0 && (
          <LandscapeRow
            titulo="Desenhos Animados"
            items={dbDesenhos.map((s) => dbToCard(s, "desenho"))}
            verTodosHref="/desenhos"
          />
        )}

        {/* Gêneros temáticos */}
        {comediaList.length > 0 && <LandscapeRow titulo="Comédia" items={comediaList} verTodosHref="/genero/35" />}
        {terrorList.length > 0   && <LandscapeRow titulo="Terror"  items={terrorList}  verTodosHref="/genero/27" />}
        {ficcaoList.length > 0   && <LandscapeRow titulo="Ficção Científica" items={ficcaoList} verTodosHref="/genero/878" />}
        {romanceList.length > 0  && <LandscapeRow titulo="Romance" items={romanceList} verTodosHref="/genero/10749" />}
        {crimeList.length > 0    && <LandscapeRow titulo="Crime"   items={crimeList}   verTodosHref="/genero/80" />}

        {/* Gêneros do banco */}
        {generoRows.map((g) =>
          g.filmes.length > 0 ? (
            <LandscapeRow key={g.id} titulo={g.nome} items={g.filmes} verTodosHref={`/genero/${g.id}`} />
          ) : null
        )}
      </div>
    </div>
  );
}
