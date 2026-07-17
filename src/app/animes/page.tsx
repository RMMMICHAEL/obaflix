import { Suspense } from "react";
import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { ContentCard } from "@/components/ui/ContentCard";
import { FilterBar } from "@/components/ui/FilterBar";
import { EpisodioRecenteRow, type EpisodioRecenteItem } from "@/components/ui/EpisodioRecenteRow";
import { prisma } from "@/lib/prisma";
import { getTrendingTV, TmdbItem } from "@/lib/tmdb";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;
const NEW_EP_MS = 48 * 60 * 60 * 1000;

const selBrowse = {
  id: true, tmdbId: true, titulo: true, poster: true, background: true, logo: true,
  sinopse: true, ano: true, nota: true, createdAt: true,
} as const;

const selHero = { id: true, titulo: true, sinopse: true, background: true } as const;

const selGrid = {
  id: true, titulo: true, poster: true, ano: true, nota: true,
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
    titulo: s.titulo, poster: s.poster ?? null, ano: s.ano ?? null, nota: s.nota ?? null,
  };
}

export default async function AnimesPage({
  searchParams,
}: {
  searchParams: { genero?: string; ano?: string; ordem?: string; q?: string; page?: string };
}) {
  const generoId = searchParams.genero ? Number(searchParams.genero) : null;
  const ano = searchParams.ano ? Number(searchParams.ano) : null;
  const ordem = searchParams.ordem ?? null;
  const q = searchParams.q ?? null;
  const page = Number(searchParams.page ?? 1);
  const isFiltered = !!(generoId || ano || ordem || q);
  const limit = 24;
  const skip = (page - 1) * limit;

  const [generos, anosRaw] = await Promise.all([
    prisma.genero.findMany({
      where: { series: { some: { serie: { tipo: "anime" } } } },
      orderBy: { nome: "asc" },
    }),
    prisma.serie.findMany({
      where: { tipo: "anime", ano: { not: null } },
      select: { ano: true },
      distinct: ["ano"],
      orderBy: { ano: "desc" },
    }),
  ]);
  const anos = anosRaw.map((a) => a.ano!).filter(Boolean) as number[];

  if (isFiltered) {
    const where: any = { tipo: "anime" };
    if (generoId) where.generos = { some: { generoId } };
    if (ano) where.ano = ano;
    if (q) where.titulo = { contains: q, mode: "insensitive" };

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
            <div className="mt-6 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
              {series.map((s) => <ContentCard key={s.id} {...toGrid(s)} />)}
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
    prisma.serie.findMany({ where: { tipo: "anime", background: { not: null } }, orderBy: { scoreDestaque: { sort: "desc", nulls: "last" } }, take: 8, select: selHero }),
    prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { popularidade: { sort: "desc", nulls: "last" } }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { scoreDestaque: { sort: "desc", nulls: "last" } }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { createdAt: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: [{ ano: "desc" }, { createdAt: "desc" }], take: 24, select: selBrowse }),
    prisma.episodio.findMany({
      where: { serie: { tipo: "anime" } },
      orderBy: { createdAt: "desc" },
      take: 24,
      select: {
        id: true, serieId: true, titulo: true, thumbnail: true,
        temporada: true, numeroEp: true, urlDub: true, urlLeg: true, createdAt: true,
        serie: { select: { titulo: true, poster: true } },
      },
    }),
    getTrendingTV("week"),
    prisma.serie.findMany({ where: { tipo: "anime", generos: { some: { generoId: 28 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "anime", generos: { some: { generoId: 12 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "anime", generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "anime", generos: { some: { generoId: 18 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "anime", generos: { some: { generoId: 9648 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "anime", generos: { some: { generoId: 10749 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
  ]);

  // Em Alta: trending real do TMDB cruzado com o catálogo local de anime; se
  // vier curto (poucos trending batem com o catálogo), completa com a lista
  // de popularidade local — nunca fica vazio/esparso.
  const trendingIds = ((tmdbTrendingTV?.results ?? []) as TmdbItem[]).map((i) => String(i.id));
  const trendingMatches = trendingIds.length
    ? await prisma.serie.findMany({ where: { tipo: "anime", tmdbId: { in: trendingIds } }, select: selBrowse })
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
    urlDub: e.urlDub ?? null,
    urlLeg: e.urlLeg ?? null,
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

        {populares.length > 0    && <LandscapeRow titulo="Populares"              items={populares.map(toRow)}    verTodosHref="/animes?ordem=popular" />}
        {emAlta.length > 0       && <LandscapeRow titulo="Em Alta"                 items={emAlta.map(toRow)} />}
        {avaliados.length > 0    && <LandscapeRow titulo="Mais Bem Avaliados"       items={avaliados.map(toRow)}    verTodosHref="/animes?ordem=nota" />}
        <EpisodioRecenteRow titulo="Novos Episódios" items={epsRecentesItems} />
        {lancamentos.length > 0  && <LandscapeRow titulo="Lançamentos"             items={lancamentos.map(toRow)}  verTodosHref="/animes?ordem=lancamento" />}
        {recentes.length > 0     && <LandscapeRow titulo="Adicionados Recentemente" items={recentes.map(toRow)}     verTodosHref="/animes?ordem=recente" />}
        {acao.length > 0      && <LandscapeRow titulo="Ação"                     items={acao.map(toRow)}      verTodosHref="/animes?genero=28" />}
        {aventura.length > 0  && <LandscapeRow titulo="Aventura"                 items={aventura.map(toRow)}  verTodosHref="/animes?genero=12" />}
        {comedia.length > 0   && <LandscapeRow titulo="Comédia"                  items={comedia.map(toRow)}   verTodosHref="/animes?genero=35" />}
        {drama.length > 0     && <LandscapeRow titulo="Drama"                    items={drama.map(toRow)}     verTodosHref="/animes?genero=18" />}
        {misterio.length > 0  && <LandscapeRow titulo="Mistério"                 items={misterio.map(toRow)}  verTodosHref="/animes?genero=9648" />}
        {romance.length > 0   && <LandscapeRow titulo="Romance"                  items={romance.map(toRow)}   verTodosHref="/animes?genero=10749" />}
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
