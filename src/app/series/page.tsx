import { serieDisponivel, FONTE_REPRODUZIVEL } from "@/lib/catalog-availability";
import { BRAZIL_SERIES_BROWSE_LIMIT, getBrazilSeriesRanking, orderBrazilSeriesRows, paginateBrazilSeriesRows } from "@/lib/brazil-series-ranking";
import { Suspense } from "react";
import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { LazyRow } from "@/components/ui/LazyRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import { ComBanners } from "@/components/ads/ComBanners";
import { FilterBar } from "@/components/ui/FilterBar";
import { EpisodioRecenteRow, type EpisodioRecenteItem } from "@/components/ui/EpisodioRecenteRow";
import { prisma } from "@/lib/prisma";
import { groupGenres, parseGenreIds } from "@/lib/genres";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;
const NEW_EP_MS = 48 * 60 * 60 * 1000;

const selBrowse = {
  id: true, titulo: true, tituloOriginal: true, poster: true, background: true, logo: true,
  sinopse: true, ano: true, nota: true, tipo: true, createdAt: true,
} as const;

const selHero = { id: true, titulo: true, sinopse: true, background: true } as const;

const selGrid = {
  id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true, tipo: true,
} as const;

function toRow(s: any) {
  return {
    id: s.id, tipo: (s.tipo ?? "serie") as "serie" | "anime" | "desenho",
    titulo: s.titulo, poster: s.poster ?? null, background: s.background ?? null,
    logo: s.logo ?? null, ano: s.ano ?? null, nota: s.nota ?? null,
    isNew: s.createdAt ? Date.now() - new Date(s.createdAt).getTime() < NEW_MS : false,
  };
}

function toGrid(s: any) {
  return {
    id: s.id, tipo: (s.tipo ?? "serie") as "serie" | "anime" | "desenho",
    titulo: s.titulo, poster: s.poster ?? null, background: s.background ?? null, logo: s.logo ?? null,
    ano: s.ano ?? null, nota: s.nota ?? null,
  };
}

export default async function SeriesPage({
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
      where: { series: { some: { serie: serieDisponivel({ tipo: "serie" }) } } },
      orderBy: { nome: "asc" },
    }),
    prisma.serie.findMany({
      where: serieDisponivel({ tipo: "serie", ano: { not: null } }),
      select: { ano: true },
      distinct: ["ano"],
      orderBy: { ano: "desc" },
    }),
  ]);
  const generos = groupGenres(generosRaw);
  const anos = anosRaw.map((a) => a.ano!).filter(Boolean) as number[];

  if (isFiltered) {
    const where: any = { tipo: "serie" };
    if (generoIds.length) where.generos = { some: { generoId: { in: generoIds } } };
    if (ano) where.ano = ano;
    if (q) where.titulo = { contains: q, mode: "insensitive" };

    const orderBy: any =
      ordem === "nota"       ? { scoreDestaque: { sort: "desc", nulls: "last" } }
      : ordem === "lancamento" ? [{ ano: "desc" }, { createdAt: "desc" }]
      : ordem === "az"        ? { titulo: "asc" }
      : ordem === "antigo"    ? { createdAt: "asc" }
      : { createdAt: "desc" };

    const brazilIds = ordem === "popular" ? await getBrazilSeriesRanking("week", BRAZIL_SERIES_BROWSE_LIMIT) : null;
    const [rawSeries, rawTotal] = await Promise.all([
      prisma.serie.findMany({
        where: serieDisponivel({ ...where, ...(brazilIds ? { id: { in: brazilIds } } : {}) }),
        orderBy: brazilIds ? undefined : orderBy,
        skip: brazilIds ? undefined : skip, take: brazilIds ? undefined : limit, select: selGrid,
      }),
      brazilIds ? Promise.resolve(0) : prisma.serie.count({ where: serieDisponivel(where) }),
    ]);
    const { series, total } = brazilIds
      ? paginateBrazilSeriesRows(brazilIds, rawSeries, page, limit)
      : { series: rawSeries, total: rawTotal };
    const pages = Math.ceil(total / limit);

    return (
      <div className="min-h-screen pb-12 pt-20">
        <div className="px-4 md:px-8">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} total={total} pages={pages} label="séries" />
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
  // "Em Alta": Brasil 7d. Hero e filtros gerais preservam as regras existentes.
  const brWeekIds = await getBrazilSeriesRanking("week", 24);
  const [heroRaw, recentes, avaliadas, populares, epsRecentesRaw, drama, crime, comedia, misterio, ficcao, terror, romance, acao] =
    await Promise.all([
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", background: { not: null } }), orderBy: { popularidade: { sort: "desc", nulls: "last" } }, take: 8, select: selHero }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie" }), orderBy: { createdAt: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie" }), orderBy: { scoreDestaque: { sort: "desc", nulls: "last" } }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ id: { in: brWeekIds } }), select: selBrowse }),
      prisma.episodio.findMany({
        where: {
          serie: { tipo: "serie" },
          ...FONTE_REPRODUZIVEL,
        },
        orderBy: { createdAt: "desc" },
        take: 24,
        select: {
          id: true, serieId: true, titulo: true, thumbnail: true,
          temporada: true, numeroEp: true, urlDub: true, urlLeg: true, createdAt: true,
          serie: { select: { titulo: true, poster: true } },
        },
      }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", generos: { some: { generoId: 18 } } }), orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", generos: { some: { generoId: 80 } } }), orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", generos: { some: { generoId: 35 } } }), orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", generos: { some: { generoId: 9648 } } }), orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", generos: { some: { generoId: 10765 } } }), orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", generos: { some: { generoId: 27 } } }), orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", generos: { some: { generoId: 10749 } } }), orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", generos: { some: { generoId: 10759 } } }), orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    ]);

  const epsRecentesItems: EpisodioRecenteItem[] = epsRecentesRaw.map((episode) => ({
    episodioId: episode.id,
    serieId: episode.serieId,
    titulo: episode.titulo ?? null,
    serieTitulo: episode.serie.titulo,
    poster: episode.serie.poster ?? null,
    thumbnail: episode.thumbnail ?? null,
    temporada: episode.temporada,
    numeroEp: episode.numeroEp,
    tipo: "serie",
    isNovoEpisodio: Date.now() - episode.createdAt.getTime() < NEW_EP_MS,
    dub: Boolean(episode.urlDub),
    leg: Boolean(episode.urlLeg),
  }));

  const heroItems = heroRaw.map((s) => ({
    id: s.id, tipo: "serie" as const,
    titulo: s.titulo, sinopse: s.sinopse ?? null,
    background: s.background!, trailerKey: null,
  }));

  return (
    <div className="min-h-screen pb-12">
      {heroItems.length > 0 && <HeroSlider items={heroItems} />}

      <div className={`mt-3 ${!heroItems.length ? "pt-20" : ""}`}>
        <ContinuarAssistindo />

        <div className="px-4 md:px-8 py-4">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} label="séries" />
          </Suspense>
        </div>

        <ComBanners>
        {populares.length > 0  && <LandscapeRow titulo="Em Alta" items={orderBrazilSeriesRows(brWeekIds, populares).map(toRow)} verTodosHref="/melhores" />}
        {epsRecentesItems.length > 0 && <LazyRow><EpisodioRecenteRow titulo="Novos Episódios" items={epsRecentesItems} /></LazyRow>}
        {recentes.length > 0   && <LandscapeRow titulo="Adicionadas Recentemente" items={recentes.map(toRow)}  verTodosHref="/series?ordem=recente" />}
        {avaliadas.length > 0  && <LazyRow><LandscapeRow titulo="Mais Bem Avaliadas"  items={avaliadas.map(toRow)}  verTodosHref="/series?ordem=nota" /></LazyRow>}
        {drama.length > 0      && <LazyRow><LandscapeRow titulo="Drama"               items={drama.map(toRow)}      verTodosHref="/genero/18" /></LazyRow>}
        {crime.length > 0      && <LazyRow><LandscapeRow titulo="Crime"               items={crime.map(toRow)}      verTodosHref="/genero/80" /></LazyRow>}
        {comedia.length > 0    && <LazyRow><LandscapeRow titulo="Comédia"             items={comedia.map(toRow)}    verTodosHref="/genero/35" /></LazyRow>}
        {misterio.length > 0   && <LazyRow><LandscapeRow titulo="Mistério"            items={misterio.map(toRow)}   verTodosHref="/genero/9648" /></LazyRow>}
        {ficcao.length > 0     && <LazyRow><LandscapeRow titulo="Ficção Científica"   items={ficcao.map(toRow)}     verTodosHref="/genero/10765" /></LazyRow>}
        {terror.length > 0     && <LazyRow><LandscapeRow titulo="Terror"              items={terror.map(toRow)}     verTodosHref="/genero/27" /></LazyRow>}
        {romance.length > 0    && <LazyRow><LandscapeRow titulo="Romance"             items={romance.map(toRow)}    verTodosHref="/genero/10749" /></LazyRow>}
        {acao.length > 0       && <LazyRow><LandscapeRow titulo="Ação & Aventura"     items={acao.map(toRow)}       verTodosHref="/genero/10759" /></LazyRow>}
        </ComBanners>
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
