import { HeroSlider } from "@/components/ui/HeroSlider";
import { ContentRow } from "@/components/ui/ContentRow";
import { RankRow } from "@/components/ui/RankRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { prisma } from "@/lib/prisma";
import {
  getTrending, getPopularMovies, getPopularTV,
  getTopRatedMovies, getTopRatedTV,
  getAiringTodayTV, discoverMovies, discoverTV, imgUrl, TmdbItem,
} from "@/lib/tmdb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

function dbToCard(r: any, tipo: CardItem["tipo"]): CardItem {
  return {
    id: r.id, tipo,
    titulo: r.titulo, poster: r.poster,
    ano: r.ano, nota: r.nota,
    urlDub: r.urlDub ?? null, urlLeg: r.urlLeg ?? null,
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
    ano: db?.ano ?? (Number((item.release_date ?? item.first_air_date ?? "").slice(0, 4)) || null),
    nota: db?.nota ?? item.vote_average ?? null,
    urlDub: db.urlDub ?? null, urlLeg: db.urlLeg ?? null,
  };
}

const selDB = { id: true, tmdbId: true, titulo: true, poster: true, ano: true, nota: true } as const;
const selFilme = { ...selDB, urlDub: true, urlLeg: true } as const;
const selSerie  = { ...selDB, tipo: true } as const;

export default async function HomePage() {
  const [
    tmdbTrending,
    tmdbPopMovies,
    tmdbPopTV,
    tmdbTopMovies,
    tmdbTopTV,
    tmdbAiringToday,
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
    ...dbGeneroFilmes
  ] = await Promise.all([
    getTrending("week"),
    getPopularMovies(),
    getPopularTV(),
    getTopRatedMovies(),
    getTopRatedTV(),
    getAiringTodayTV(),
    discoverTV({ with_original_language: "ja", with_genres: "16", sort_by: "vote_average.desc", "vote_count.gte": 200 }),
    discoverMovies({ with_genres: "35", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "27", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "878", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "10749", sort_by: "popularity.desc" }),
    discoverMovies({ with_genres: "80", sort_by: "popularity.desc" }),
    prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 24, select: selFilme }),
    prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 24, select: selSerie }),
    prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { nota: "desc" }, take: 24, select: selSerie }),
    prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { nota: "desc" }, take: 24, select: selSerie }),
    ...GENEROS.map((g) =>
      prisma.filme.findMany({
        where: { generos: { some: { generoId: g.id } } },
        orderBy: { nota: "desc" },
        take: 24,
        select: selFilme,
      })
    ),
  ]);

  // Build tmdbId→DB maps
  const allTmdbIds = [
    ...(tmdbTrending?.results ?? []),
    ...(tmdbPopMovies?.results ?? []),
    ...(tmdbPopTV?.results ?? []),
    ...(tmdbTopMovies?.results ?? []),
    ...(tmdbTopTV?.results ?? []),
    ...(tmdbAiringToday?.results ?? []),
    ...(tmdbAnime?.results ?? []),
    ...(tmdbComedia?.results ?? []),
    ...(tmdbTerror?.results ?? []),
    ...(tmdbFiccao?.results ?? []),
    ...(tmdbRomance?.results ?? []),
    ...(tmdbCrime?.results ?? []),
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

  const trending      = tmdbList(tmdbTrending?.results ?? [], "filme").slice(0, 20);
  const popMovies     = tmdbList(tmdbPopMovies?.results ?? [], "filme").slice(0, 10);
  const popTV         = tmdbList(tmdbPopTV?.results ?? [], "serie").slice(0, 10);
  const topMovies     = tmdbList(tmdbTopMovies?.results ?? [], "filme").slice(0, 24);
  const topTV         = tmdbList(tmdbTopTV?.results ?? [], "serie").slice(0, 24);
  const airingToday   = tmdbList(tmdbAiringToday?.results ?? [], "serie").slice(0, 10);
  const animeList     = tmdbList(tmdbAnime?.results ?? [], "anime").slice(0, 24);
  const comediaList   = tmdbList(tmdbComedia?.results ?? [], "filme").slice(0, 24);
  const terrorList    = tmdbList(tmdbTerror?.results ?? [], "filme").slice(0, 24);
  const ficcaoList    = tmdbList(tmdbFiccao?.results ?? [], "filme").slice(0, 24);
  const romanceList   = tmdbList(tmdbRomance?.results ?? [], "filme").slice(0, 24);
  const crimeList     = tmdbList(tmdbCrime?.results ?? [], "filme").slice(0, 24);

  // Hero: trending with backdrop
  const heroRaw = (tmdbTrending?.results ?? []).slice(0, 8);
  const heroItems = heroRaw.map((item) => {
    const db = mergeMap(item).get(String(item.id));
    return {
      id: db?.id ?? `tmdb-${item.id}`,
      tipo: item.media_type === "tv" ? "serie" : "filme",
      titulo: db?.titulo ?? item.title ?? item.name ?? "",
      sinopse: item.overview ?? null,
      background: item.backdrop_path ? imgUrl(item.backdrop_path, "original") : db?.poster ?? null,
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

      <div className="mt-4 space-y-1">
        {/* 1 — Continuar Assistindo (sempre primeiro) */}
        <ContinuarAssistindo />

        {/* 2 — Em Alta */}
        {trending.length > 0 && (
          <ContentRow titulo="🔥 Em Alta Esta Semana" items={trending} />
        )}

        {/* 3 — Top 10 Filmes */}
        {popMovies.length > 0 && (
          <RankRow titulo="🏆 Top 10 Filmes" items={popMovies} verTodosHref="/filmes?ordem=nota" />
        )}

        {/* 4 — Recentemente adicionados - Filmes */}
        {dbRecFilmes.length > 0 && (
          <ContentRow titulo="🆕 Novos Filmes" items={dbRecFilmes.map((f) => dbToCard(f, "filme"))} verTodosHref="/filmes" />
        )}

        {/* 5 — Filmes Melhor Avaliados */}
        {topMovies.length > 0 && (
          <ContentRow titulo="⭐ Filmes Melhor Avaliados" items={topMovies} verTodosHref="/filmes?ordem=nota" />
        )}

        {/* 6 — Séries Populares */}
        {popTV.length > 0 && (
          <ContentRow titulo="📺 Séries Populares" items={popTV} />
        )}

        {/* 7 — Top 10 Séries */}
        {airingToday.length > 0 && (
          <RankRow titulo="🏆 Top 10 Séries de Hoje" items={airingToday} verTodosHref="/series" />
        )}

        {/* 8 — Novos séries */}
        {dbRecSeries.length > 0 && (
          <ContentRow titulo="🆕 Novas Séries" items={dbRecSeries.map((s) => dbToCard(s, "serie"))} verTodosHref="/series" />
        )}

        {/* 9 — Séries Melhor Avaliadas */}
        {topTV.length > 0 && (
          <ContentRow titulo="⭐ Séries Melhor Avaliadas" items={topTV} verTodosHref="/series?ordem=nota" />
        )}

        {/* 10 — Animes */}
        {animeList.length > 0 && (
          <ContentRow titulo="🎌 Animes" items={animeList} verTodosHref="/animes" />
        )}
        {dbAnimes.length > 0 && (
          <ContentRow titulo="🎌 Animes no Catálogo" items={dbAnimes.map((s) => dbToCard(s, "anime"))} verTodosHref="/animes" />
        )}

        {/* 11 — Desenhos */}
        {dbDesenhos.length > 0 && (
          <ContentRow titulo="🖼️ Desenhos" items={dbDesenhos.map((s) => dbToCard(s, "desenho"))} verTodosHref="/desenhos" />
        )}

        {/* 12 — Gêneros temáticos */}
        {comediaList.length > 0 && (
          <ContentRow titulo="😂 Comédia" items={comediaList} verTodosHref="/genero/35" />
        )}
        {terrorList.length > 0 && (
          <ContentRow titulo="👻 Terror" items={terrorList} verTodosHref="/genero/27" />
        )}
        {ficcaoList.length > 0 && (
          <ContentRow titulo="🚀 Ficção Científica" items={ficcaoList} verTodosHref="/genero/878" />
        )}
        {romanceList.length > 0 && (
          <ContentRow titulo="❤️ Romance" items={romanceList} verTodosHref="/genero/10749" />
        )}
        {crimeList.length > 0 && (
          <ContentRow titulo="🔫 Crime" items={crimeList} verTodosHref="/genero/80" />
        )}

        {/* 13 — Rows do banco por gênero */}
        {generoRows.map((g) =>
          g.filmes.length > 0 ? (
            <ContentRow key={g.id} titulo={g.nome} items={g.filmes} verTodosHref={`/genero/${g.id}`} />
          ) : null
        )}
      </div>
    </div>
  );
}
