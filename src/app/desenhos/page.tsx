import { Suspense } from "react";
import Link from "next/link";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { LazyRow } from "@/components/ui/LazyRow";
import { KidsHero } from "@/components/ui/KidsHero";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { ContentCard } from "@/components/ui/ContentCard";
import { FilterBar } from "@/components/ui/FilterBar";
import { EpisodioRecenteRow, type EpisodioRecenteItem } from "@/components/ui/EpisodioRecenteRow";
import { AnimationCollectionsRow } from "@/components/ui/CollectionsRow";
import { prisma } from "@/lib/prisma";
import { groupGenres, parseGenreIds } from "@/lib/genres";
import { ANIMATION_STUDIOS, matchStudioTitles } from "@/lib/editorialCatalog";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;
const NEW_EP_MS = 48 * 60 * 60 * 1000;

const selBrowse = {
  id: true, titulo: true, tituloOriginal: true, poster: true, background: true, logo: true,
  sinopse: true, ano: true, nota: true, createdAt: true,
} as const;

const selGrid = {
  id: true, titulo: true, poster: true, ano: true, nota: true,
} satisfies Prisma.SerieSelect;

const selAnimationFilm = {
  id: true, titulo: true, tituloOriginal: true, poster: true, background: true, logo: true,
  ano: true, nota: true, urlDub: true, urlLeg: true,
} satisfies Prisma.FilmeSelect;

const selAnimationSeries = {
  id: true, titulo: true, tituloOriginal: true, poster: true, background: true, logo: true,
  ano: true, nota: true, tipo: true,
} satisfies Prisma.SerieSelect;

function toRow(s: any) {
  return {
    id: s.id, tipo: "desenho" as const, titulo: s.titulo,
    poster: s.poster ?? null, background: s.background ?? null, logo: s.logo ?? null,
    ano: s.ano ?? null, nota: s.nota ?? null,
    isNew: s.createdAt ? Date.now() - new Date(s.createdAt).getTime() < NEW_MS : false,
  };
}

function toGrid(s: any) {
  return {
    id: s.id, tipo: "desenho" as const,
    titulo: s.titulo, poster: s.poster ?? null, ano: s.ano ?? null, nota: s.nota ?? null,
  };
}

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
  const studioTitleFilters = selectedStudio.titles.flatMap((title) => ([
    { titulo: { startsWith: title, mode: "insensitive" as const } },
    { tituloOriginal: { startsWith: title, mode: "insensitive" as const } },
  ]));

  const [generosRaw, anosRaw] = await Promise.all([
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
  ]);
  const generos = groupGenres(generosRaw);
  const anos = anosRaw.map((a) => a.ano!).filter(Boolean) as number[];

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

    const [series, total] = await Promise.all([
      prisma.serie.findMany({ where, orderBy, skip, take: limit, select: selGrid }),
      prisma.serie.count({ where }),
    ]);
    const pages = Math.ceil(total / limit);

    return (
      <div className="min-h-screen pb-12 pt-20">
        <div className="px-4 md:px-8">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} total={total} pages={pages} label="desenhos" />
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

  // Browse mode. As consultas de estúdio são direcionadas apenas ao estúdio
  // selecionado, evitando carregar milhares de títulos a cada visita.
  const [populares, recentes, avaliados, epsRecentesRaw, acao, aventura, comedia, familia, animationFilms, animationSeries] =
    await Promise.all([
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { popularidade: { sort: "desc", nulls: "last" } }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { createdAt: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { scoreDestaque: { sort: "desc", nulls: "last" } }, take: 24, select: selBrowse }),
      prisma.episodio.findMany({
        where: {
          serie: { tipo: "desenho" },
          OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }],
        },
        orderBy: { createdAt: "desc" },
        take: 24,
        select: {
          id: true, serieId: true, titulo: true, thumbnail: true,
          temporada: true, numeroEp: true, urlDub: true, urlLeg: true, createdAt: true,
          serie: { select: { titulo: true, poster: true } },
        },
      }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 28 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 12 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 10751 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({
        where: {
          AND: [
            { generos: { some: { generoId: 16 } } },
            { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
            { OR: studioTitleFilters },
          ],
        },
        orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
        take: 120,
        select: selAnimationFilm,
      }),
      prisma.serie.findMany({
        where: {
          AND: [
            { OR: [{ generos: { some: { generoId: 16 } } }, { tipo: { in: ["anime", "desenho"] } }] },
            { episodios: { some: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] } } },
            { OR: studioTitleFilters },
          ],
        },
        orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
        take: 80,
        select: selAnimationSeries,
      }),
    ]);

  const animationCandidates = [
    ...animationFilms.map((item) => ({ ...item, tipo: "filme" as const })),
    ...animationSeries.map((item) => ({
      ...item,
      tipo: (item.tipo === "anime" ? "anime" : "desenho") as "anime" | "desenho",
      urlDub: null,
      urlLeg: null,
    })),
  ];

  const toAnimationRow = (item: (typeof animationCandidates)[number]) => ({
    id: item.id,
    tipo: item.tipo,
    titulo: item.titulo,
    poster: item.poster ?? null,
    background: item.background ?? null,
    logo: item.logo ?? null,
    ano: item.ano ?? null,
    nota: item.nota ?? null,
    urlDub: item.urlDub ?? null,
    urlLeg: item.urlLeg ?? null,
  });

  const studioItems = matchStudioTitles(selectedStudio.titles, animationCandidates).slice(0, 36).map(toAnimationRow);
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
    isNovoEpisodio: Date.now() - episode.createdAt.getTime() < NEW_EP_MS,
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

        <Suspense fallback={<CollectionRowSkeleton />}><AnimationCollectionsRow /></Suspense>

        <section id="estudios" className="scroll-mt-24 px-6 py-8 md:px-12">
          <div className="grid gap-7 lg:grid-cols-[210px_minmax(0,1fr)]">
            <div>
              <p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-[oklch(0.82_0.10_96)]">Estúdios</p>
              <nav className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide lg:max-h-[520px] lg:flex-col lg:overflow-y-auto lg:pr-2" aria-label="Estúdios de animação">
                {ANIMATION_STUDIOS.map((studio) => {
                  const active = studio.id === selectedStudio.id;
                  return (
                    <Link
                      key={studio.id}
                      href={`/desenhos?studio=${studio.id}#estudios`}
                      aria-current={active ? "page" : undefined}
                      className={`inline-flex min-h-11 shrink-0 items-center rounded-xl px-4 text-sm font-bold transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.92_0.12_96)] ${active ? "bg-[oklch(0.87_0.16_96)] text-[oklch(0.24_0.06_205)]" : "bg-[oklch(0.24_0.07_190)] text-[oklch(0.92_0.025_190)] hover:bg-[oklch(0.29_0.08_190)]"}`}
                    >
                      <span className="mr-2 h-2 w-2 rounded-full" style={{ backgroundColor: studio.accent }} aria-hidden="true" />
                      {studio.name}
                    </Link>
                  );
                })}
              </nav>
            </div>

            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[oklch(0.70_0.055_205)]">Infantil / {selectedStudio.name}</p>
              <h2 className="mt-1 text-2xl font-black tracking-tight">{selectedStudio.name}</h2>
              {studioItems.length > 0 ? (
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {studioItems.map((item) => <ContentCard key={`${item.tipo}-${item.id}`} {...item} />)}
                </div>
              ) : (
                <p className="mt-8 rounded-xl bg-[oklch(0.21_0.045_205)] p-6 text-sm text-[oklch(0.76_0.035_205)]">Nenhum título disponível deste estúdio no catálogo atual.</p>
              )}
            </div>
          </div>
        </section>

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

function CollectionRowSkeleton() {
  return <div className="mx-6 my-5 h-72 animate-pulse rounded-xl bg-[oklch(0.21_0.045_205)] md:mx-12" aria-hidden="true" />;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-white/40 text-lg">Nenhum resultado encontrado</p>
      <p className="text-white/25 text-sm mt-2">Tente ajustar os filtros</p>
    </div>
  );
}
