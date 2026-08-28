import { Suspense } from "react";
import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { LazyRow } from "@/components/ui/LazyRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import { FilterBar } from "@/components/ui/FilterBar";
import { EpisodioRecenteRow, type EpisodioRecenteItem } from "@/components/ui/EpisodioRecenteRow";
import { prisma } from "@/lib/prisma";
import { getTrendingTV, TmdbItem } from "@/lib/tmdb";
import { groupGenres, parseGenreIds } from "@/lib/genres";
import { ANIME_HOME_EXCLUSIONS } from "@/lib/editorialCatalog";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;
const NEW_EP_MS = 48 * 60 * 60 * 1000;
const animeCatalogWhere: Prisma.SerieWhereInput = {
  tipo: "anime",
  titulo: { notIn: [...ANIME_HOME_EXCLUSIONS] },
};

const selBrowse = {
  id: true, tmdbId: true, titulo: true, poster: true, background: true, logo: true,
  sinopse: true, ano: true, nota: true, createdAt: true,
} as const;

const selHero = { id: true, titulo: true, sinopse: true, background: true } as const;

const selGrid = {
  id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true,
} as const;

function toRow(s: any) {
  return {
    id: s.id, tipo: "anime" as const, titulo: s.titulo,
    poster: s.poster ?? null, background: s.background ?? null, logo: s.logo ?? null,
    ano: s.ano ?? null, nota: s.nota ?? null,
    isNew: s.createdAt ? Date.now() - new Date(s.createdAt).getTime() < NEW_MS : false,
  };
}

function toGrid(s: any) {
  return {
    id: s.id, tipo: "anime" as const,
    titulo: s.titulo, poster: s.poster ?? null, background: s.background ?? null, logo: s.logo ?? null,
    ano: s.ano ?? null, nota: s.nota ?? null,
  };
}

export default async function AnimesPage({
  searchParams,
}: {
  searchParams: { genero?: string; ano?: string; ordem?: string; q?: string; page?: string };
}) {
  const generoIds = parseGenreIds(searchParams.genero);
  const ano = searchParams.ano ? Number(searchParams.ano) : null;
  const ordem = searchParams.ordem ?? null;
  const q = searchParams.q ?? null;
  const page = Number(searchParams.page ?? 1);
  const isFiltered = !!(generoIds.length || ano || ordem || q);
  const limit = 24;
  const skip = (page - 1) * limit;

  const [generosRaw, anosRaw] = await Promise.all([
    prisma.genero.findMany({
      where: { series: { some: { serie: { tipo: "anime" } } } },
      orderBy: { nome: "asc" },
    }),
    prisma.serie.findMany({
      where: { ...animeCatalogWhere, ano: { not: null } },
      select: { ano: true },
      distinct: ["ano"],
      orderBy: { ano: "desc" },
    }),
  ]);
  const generos = groupGenres(generosRaw);
  const anos = anosRaw.map((a) => a.ano!).filter(Boolean) as number[];

  if (isFiltered) {
    const where: any = { ...animeCatalogWhere };
    if (generoIds.length) where.generos = { some: { generoId: { in: generoIds } } };
    if (ano) where.ano = ano;
    if (q) where.AND = [{ titulo: { contains: q, mode: "insensitive" } }];

    const orderBy: any =
      ordem === "nota"       ? { scoreDestaque: { sort: "desc", nulls: "last" } }
      : ordem === "popular"   ? { popularidade: { sort: "desc", nulls: "last" } }
      : ordem === "lancamento" ? [{ ano: "desc" }, { createdAt: "desc" }]
      : ordem === "az"        ? { titulo: "asc" }
      : ordem === "antigo"    ? { createdAt: "asc" }
      : { createdAt: "desc" };

    const [series, total] = await Promise.all([
      prisma.serie.findMany({ where, orderBy, skip, take: limit, select: selGrid }),
      prisma.serie.count({ where }),
    ]);
    const pages = Math.ceil(total / limit);

    return (
      <div className="min-h-screen pb-12 pt-20">
        <div className="px-4 md:px-8">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} total={total} pages={pages} label="animes" />
          </Suspense>
          {series.length > 0 ? (
            <div className="mt-6 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {series.map((s) => <LandscapeCard key={s.id} {...toGrid(s)} layout="grid" />)}
            </div>
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    );
  }

  // Browse mode
  const [
    heroRaw, populares, avaliados, recentes, lancamentos, epsRecentesRaw, tmdbTrendingTV,
    acao, aventura, comedia, drama, misterio, romance,
  ] = await Promise.all([
    prisma.serie.findMany({ where: { ...animeCatalogWhere, background: { not: null } }, orderBy: { popularidade: { sort: "desc", nulls: "last" } }, take: 8, select: selHero }),
    prisma.serie.findMany({ where: animeCatalogWhere, orderBy: { popularidade: { sort: "desc", nulls: "last" } }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: animeCatalogWhere, orderBy: { scoreDestaque: { sort: "desc", nulls: "last" } }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: animeCatalogWhere, orderBy: { createdAt: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: animeCatalogWhere, orderBy: [{ ano: "desc" }, { createdAt: "desc" }], take: 24, select: selBrowse }),
    prisma.episodio.findMany({
      where: { serie: animeCatalogWhere },
      orderBy: { createdAt: "desc" },
      take: 24,
      select: {
        id: true, serieId: true, titulo: true, thumbnail: true,
        temporada: true, numeroEp: true, urlDub: true, urlLeg: true, createdAt: true,
        serie: { select: { titulo: true, poster: true } },
      },
    }),
    getTrendingTV("week"),
    prisma.serie.findMany({ where: { ...animeCatalogWhere, generos: { some: { generoId: 28 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { ...animeCatalogWhere, generos: { some: { generoId: 12 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { ...animeCatalogWhere, generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { ...animeCatalogWhere, generos: { some: { generoId: 18 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { ...animeCatalogWhere, generos: { some: { generoId: 9648 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { ...animeCatalogWhere, generos: { some: { generoId: 10749 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
  ]);

  // Em Alta: trending real do TMDB cruzado com o catálogo local de anime; se
  // vier curto (poucos trending batem com o catálogo), completa com a lista
  // de popularidade local — nunca fica vazio/esparso.
  const trendingIds = ((tmdbTrendingTV?.results ?? []) as TmdbItem[]).map((i) => String(i.id));
  const trendingMatches = trendingIds.length
    ? await prisma.serie.findMany({ where: { ...animeCatalogWhere, tmdbId: { in: trendingIds } }, select: selBrowse })
    : [];
  const trendingMap = new Map(trendingMatches.map((s) => [s.tmdbId!, s]));
  const emAltaOrdered = trendingIds.map((id) => trendingMap.get(id)).filter(Boolean) as typeof trendingMatches;
  const emAlta = emAltaOrdered.length >= 8 ? emAltaOrdered.slice(0, 24) : populares;

  const heroItems = heroRaw.map((s) => ({
    id: s.id, tipo: "anime" as const,
    titulo: s.titulo, sinopse: s.sinopse ?? null,
    background: s.background!, trailerKey: null,
  }));

  const epsRecentesItems: EpisodioRecenteItem[] = epsRecentesRaw.map((e) => ({
    episodioId: e.id,
    serieId: e.serieId,
    titulo: e.titulo ?? null,
    serieTitulo: e.serie.titulo,
    poster: e.serie.poster ?? null,
    thumbnail: e.thumbnail ?? null,
    temporada: e.temporada,
    numeroEp: e.numeroEp,
    tipo: "anime",
    isNovoEpisodio: e.createdAt ? Date.now() - new Date(e.createdAt).getTime() < NEW_EP_MS : false,
    dub: Boolean(e.urlDub),
    leg: Boolean(e.urlLeg),
  }));

  return (
    <div className="min-h-screen pb-12">
      {heroItems.length > 0 && <HeroSlider items={heroItems} />}

      <div className={`mt-3 ${!heroItems.length ? "pt-20" : ""}`}>
        <ContinuarAssistindo />

        <div className="px-4 md:px-8 py-4">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} label="animes" />
          </Suspense>
        </div>

        {emAlta.length > 0       && <LandscapeRow titulo="Em Alta" items={emAlta.map(toRow)} />}
        <LazyRow><EpisodioRecenteRow titulo="Novos Episódios" items={epsRecentesItems} /></LazyRow>
        {lancamentos.length > 0  && <LazyRow><LandscapeRow titulo="Lançamentos"             items={lancamentos.map(toRow)} verTodosHref="/animes?ordem=lancamento" /></LazyRow>}
        {recentes.length > 0     && <LazyRow><LandscapeRow titulo="Adicionados Recentemente" items={recentes.map(toRow)}    verTodosHref="/animes?ordem=recente" /></LazyRow>}
        {avaliados.length > 0    && <LazyRow><LandscapeRow titulo="Melhores de Todos os Tempos" items={avaliados.map(toRow)} verTodosHref="/animes?ordem=nota" /></LazyRow>}
        {acao.length > 0      && <LazyRow><LandscapeRow titulo="Ação"     items={acao.map(toRow)}      verTodosHref="/animes?genero=28" /></LazyRow>}
        {aventura.length > 0  && <LazyRow><LandscapeRow titulo="Aventura" items={aventura.map(toRow)}  verTodosHref="/animes?genero=12" /></LazyRow>}
        {comedia.length > 0   && <LazyRow><LandscapeRow titulo="Comédia"  items={comedia.map(toRow)}   verTodosHref="/animes?genero=35" /></LazyRow>}
        {drama.length > 0     && <LazyRow><LandscapeRow titulo="Drama"    items={drama.map(toRow)}     verTodosHref="/animes?genero=18" /></LazyRow>}
        {misterio.length > 0  && <LazyRow><LandscapeRow titulo="Mistério" items={misterio.map(toRow)}  verTodosHref="/animes?genero=9648" /></LazyRow>}
        {romance.length > 0   && <LazyRow><LandscapeRow titulo="Romance"  items={romance.map(toRow)}   verTodosHref="/animes?genero=10749" /></LazyRow>}
      </div>
    </div>
  );
}

function FilterBarSkeleton() {
  return (
    <div className="flex gap-2 items-center">
      <div className="h-9 w-52 rounded-full bg-white/[0.06] animate-pulse" />
      <div className="h-9 w-28 rounded-full bg-white/[0.06] animate-pulse" />
      <div className="h-9 w-28 rounded-full bg-white/[0.06] animate-pulse" />
      <div className="h-9 w-24 rounded-full bg-white/[0.06] animate-pulse" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-white/40 text-lg">Nenhum resultado encontrado</p>
      <p className="text-white/25 text-sm mt-2">Tente ajustar os filtros</p>
    </div>
  );
}
