import { Suspense } from "react";
import { unstable_cache } from "next/cache";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { LazyRow } from "@/components/ui/LazyRow";
import { KidsHero } from "@/components/ui/KidsHero";
import { KidsStudioBrowser } from "@/components/ui/KidsStudioBrowser";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import { FilterBar } from "@/components/ui/FilterBar";
import { EpisodioRecenteRow, type EpisodioRecenteItem } from "@/components/ui/EpisodioRecenteRow";
import { AnimationCollectionsRow } from "@/components/ui/CollectionsRow";
import { prisma } from "@/lib/prisma";
import { groupGenres, parseGenreIds } from "@/lib/genres";
import { ANIMATION_STUDIOS } from "@/lib/editorialCatalog";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;
const NEW_EP_MS = 48 * 60 * 60 * 1000;

const selBrowse = {
  id: true, titulo: true, tituloOriginal: true, poster: true, background: true, backgroundTituloPt: true, logo: true,
  ano: true, nota: true, createdAt: true,
} as const;

const selBrowseWithGenres = {
  ...selBrowse,
  generos: { select: { generoId: true } },
} as const;

const selGrid = {
  id: true, titulo: true, poster: true, background: true, backgroundTituloPt: true, ano: true, nota: true,
} satisfies Prisma.SerieSelect;

function toRow(s: any) {
  return {
    id: s.id, tipo: "desenho" as const, titulo: s.titulo,
    poster: s.poster ?? null, background: s.background ?? null,
    backgroundTituloPt: s.backgroundTituloPt ?? null, logo: s.logo ?? null,
    ano: s.ano ?? null, nota: s.nota ?? null,
    isNew: s.createdAt ? Date.now() - new Date(s.createdAt).getTime() < NEW_MS : false,
  };
}

function toGrid(s: any) {
  return {
    id: s.id, tipo: "desenho" as const,
    titulo: s.titulo, poster: s.poster ?? null, background: s.background ?? null,
    backgroundTituloPt: s.backgroundTituloPt ?? null,
    ano: s.ano ?? null, nota: s.nota ?? null,
  };
}

const getBrowseData = unstable_cache(
  async () => Promise.all([
    prisma.genero.findMany({
      where: { series: { some: { serie: { tipo: "desenho" } } } },
      orderBy: { nome: "asc" },
    }),
    prisma.serie.findMany({
      where: { tipo: "desenho", ano: { not: null } },
      select: { ano: true },
      distinct: ["ano"],
      orderBy: { ano: "desc" },
    }),
    prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { popularidade: { sort: "desc", nulls: "last" } }, take: 72, select: selBrowseWithGenres }),
    prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { createdAt: "desc" }, take: 18, select: selBrowse }),
    prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { scoreDestaque: { sort: "desc", nulls: "last" } }, take: 18, select: selBrowse }),
    prisma.episodio.findMany({
      where: {
        serie: { tipo: "desenho" },
        OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
      take: 12,
      select: {
        id: true, serieId: true, titulo: true, thumbnail: true,
        temporada: true, numeroEp: true, urlDub: true, urlLeg: true, createdAt: true,
        serie: { select: { titulo: true, poster: true } },
      },
    }),
  ]),
  ["desenhos-browse-v3"],
  { revalidate: 120, tags: ["desenhos"] },
);

export default async function DesenhoPage({
  searchParams,
}: {
  searchParams: { genero?: string; ano?: string; ordem?: string; q?: string; page?: string; studio?: string };
}) {
  const generoIds = parseGenreIds(searchParams.genero);
  const ano = searchParams.ano ? Number(searchParams.ano) : null;
  const ordem = searchParams.ordem ?? null;
  const q = searchParams.q ?? null;
  const page = Number(searchParams.page ?? 1);
  const isFiltered = !!(generoIds.length || ano || ordem || q);
  const limit = 24;
  const skip = (page - 1) * limit;
  const selectedStudio = ANIMATION_STUDIOS.find((studio) => studio.id === searchParams.studio) ?? ANIMATION_STUDIOS[0];

  if (isFiltered) {
    const where: any = { tipo: "desenho" };
    if (generoIds.length) where.generos = { some: { generoId: { in: generoIds } } };
    if (ano) where.ano = ano;
    if (q) where.titulo = { contains: q, mode: "insensitive" };

    const orderBy: any =
      ordem === "nota"       ? { scoreDestaque: { sort: "desc", nulls: "last" } }
      : ordem === "popular"   ? { popularidade: { sort: "desc", nulls: "last" } }
      : ordem === "lancamento" ? [{ ano: "desc" }, { createdAt: "desc" }]
      : ordem === "az"        ? { titulo: "asc" }
      : ordem === "antigo"    ? { createdAt: "asc" }
      : { createdAt: "desc" };

    const [generosRaw, anosRaw, series, total] = await Promise.all([
      prisma.genero.findMany({
        where: { series: { some: { serie: { tipo: "desenho" } } } },
        orderBy: { nome: "asc" },
      }),
      prisma.serie.findMany({
        where: { tipo: "desenho", ano: { not: null } },
        select: { ano: true },
        distinct: ["ano"],
        orderBy: { ano: "desc" },
      }),
      prisma.serie.findMany({ where, orderBy, skip, take: limit, select: selGrid }),
      prisma.serie.count({ where }),
    ]);
    const generos = groupGenres(generosRaw);
    const anos = anosRaw.map((item) => item.ano!).filter(Boolean) as number[];
    const pages = Math.ceil(total / limit);

    return (
      <div className="min-h-screen pb-12 pt-20">
        <div className="px-4 md:px-8">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} total={total} pages={pages} label="desenhos" />
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

  // Browse mode. A vitrine compartilhada fica em cache curto; a grade de
  // estúdios é carregada separadamente apenas quando se aproxima da tela.
  const [generosRaw, anosRaw, popularCatalog, recentes, avaliados, epsRecentesRaw] =
    await getBrowseData();

  const generos = groupGenres(generosRaw);
  const anos = anosRaw.map((item) => item.ano!).filter(Boolean) as number[];
  const populares = popularCatalog.slice(0, 18);
  const byGenre = (genreId: number) => popularCatalog
    .filter((item) => item.generos.some((genre) => genre.generoId === genreId))
    .slice(0, 12);
  const acao = byGenre(28);
  const aventura = byGenre(12);
  const comedia = byGenre(35);
  const familia = byGenre(10751);

  const featured = populares.slice(0, 3).map(toRow);
  const epsRecentesItems: EpisodioRecenteItem[] = epsRecentesRaw.map((episode) => ({
    episodioId: episode.id,
    serieId: episode.serieId,
    titulo: episode.titulo ?? null,
    serieTitulo: episode.serie.titulo,
    poster: episode.serie.poster ?? null,
    thumbnail: episode.thumbnail ?? null,
    temporada: episode.temporada,
    numeroEp: episode.numeroEp,
    tipo: "desenho",
    isNovoEpisodio: Date.now() - new Date(episode.createdAt).getTime() < NEW_EP_MS,
    urlDub: episode.urlDub ?? null,
    urlLeg: episode.urlLeg ?? null,
  }));

  return (
    <div className="min-h-screen bg-[oklch(0.16_0.035_205)] pb-12 text-[oklch(0.96_0.008_205)]">
      <KidsHero items={featured} />

      <div>
        <div className="px-4 md:px-8 py-4">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} label="desenhos" />
          </Suspense>
        </div>

        {populares.length > 0 && <LandscapeRow titulo="Em Alta" items={populares.map(toRow)} verTodosHref="/desenhos?ordem=popular" />}
        <LazyRow><EpisodioRecenteRow titulo="Novos Episódios" items={epsRecentesItems} /></LazyRow>
        {recentes.length > 0  && <LandscapeRow titulo="Adicionados Recentemente" items={recentes.map(toRow)}  verTodosHref="/desenhos?ordem=recente" />}
        <ContinuarAssistindo />
        {avaliados.length > 0 && <LandscapeRow titulo="Melhores de Todos os Tempos" items={avaliados.map(toRow)} verTodosHref="/desenhos?ordem=nota" />}

        <LazyRow height={260}><AnimationCollectionsRow /></LazyRow>

        <KidsStudioBrowser
          initialStudioId={selectedStudio.id}
          studios={ANIMATION_STUDIOS.map(({ id, name, accent }) => ({ id, name, accent }))}
        />

        {acao.length > 0      && <LazyRow><LandscapeRow titulo="Ação"     items={acao.map(toRow)}      verTodosHref="/genero/28" /></LazyRow>}
        {aventura.length > 0  && <LazyRow><LandscapeRow titulo="Aventura" items={aventura.map(toRow)}  verTodosHref="/genero/12" /></LazyRow>}
        {comedia.length > 0   && <LazyRow><LandscapeRow titulo="Comédia"  items={comedia.map(toRow)}   verTodosHref="/genero/35" /></LazyRow>}
        {familia.length > 0   && <LazyRow><LandscapeRow titulo="Família"  items={familia.map(toRow)}   verTodosHref="/genero/10751" /></LazyRow>}
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
