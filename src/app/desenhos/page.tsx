import { Suspense } from "react";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { LazyRow } from "@/components/ui/LazyRow";
import { KidsHero } from "@/components/ui/KidsHero";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { ContentCard } from "@/components/ui/ContentCard";
import { FilterBar } from "@/components/ui/FilterBar";
import { prisma } from "@/lib/prisma";
import { groupGenres, parseGenreIds } from "@/lib/genres";
import { ANIMATION_STUDIOS, matchStudioTitles } from "@/lib/editorialCatalog";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;

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
  episodios: {
    where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
    select: { urlDub: true, urlLeg: true },
    take: 12,
  },
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

  // Browse mode
  const [avaliados, recentes, acao, aventura, comedia, familia, animacao, animationFilms, animationSeries] =
    await Promise.all([
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { scoreDestaque: { sort: "desc", nulls: "last" } }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { createdAt: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 28 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 12 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 10751 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 16 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({
        where: {
          generos: { some: { generoId: 16 } },
          OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }],
        },
        orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
        take: 2500,
        select: selAnimationFilm,
      }),
      prisma.serie.findMany({
        where: {
          OR: [{ generos: { some: { generoId: 16 } } }, { tipo: { in: ["anime", "desenho"] } }],
          episodios: { some: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] } },
        },
        orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
        take: 2500,
        select: selAnimationSeries,
      }),
    ]);

  const animationCandidates = [
    ...animationFilms.map((item) => ({ ...item, tipo: "filme" as const })),
    ...animationSeries.map((item) => ({
      ...item,
      tipo: (item.tipo === "anime" ? "anime" : "desenho") as "anime" | "desenho",
      urlDub: item.episodios.some((episode) => Boolean(episode.urlDub)) ? "disponível" : null,
      urlLeg: item.episodios.some((episode) => Boolean(episode.urlLeg)) ? "disponível" : null,
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

  const studioRows = ANIMATION_STUDIOS
    .map((studio) => ({
      ...studio,
      items: matchStudioTitles(studio.titles, animationCandidates).slice(0, 24).map(toAnimationRow),
    }))
    .filter((studio) => studio.items.length >= 2);

  const featured = studioRows
    .flatMap((studio) => studio.items.slice(0, 1))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id && candidate.tipo === item.tipo) === index)
    .slice(0, 3);

  return (
    <div className="min-h-screen bg-[oklch(0.145_0.025_272)] pb-12">
      <KidsHero items={featured} />

      <div className="mt-3">
        <ContinuarAssistindo />

        <div className="px-4 md:px-8 py-4">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} label="desenhos" />
          </Suspense>
        </div>

        {studioRows.length > 0 && (
          <section id="estudios" className="scroll-mt-24 px-6 pb-2 pt-4 md:px-12">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[oklch(0.77_0.10_278)]">Escolha um estúdio</p>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-2 scrollbar-hide" aria-label="Estúdios de animação">
              {studioRows.map((studio) => (
                <a
                  key={studio.id}
                  href={`#studio-${studio.id}`}
                  className="inline-flex min-h-10 shrink-0 items-center rounded-full bg-[oklch(0.21_0.04_272)] px-4 text-sm font-semibold text-[oklch(0.91_0.015_275)] ring-1 ring-white/10 transition-colors hover:bg-[oklch(0.25_0.055_272)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{ outlineColor: studio.accent }}
                >
                  <span className="mr-2 h-2 w-2 rounded-full" style={{ backgroundColor: studio.accent }} aria-hidden="true" />
                  {studio.name}
                </a>
              ))}
            </div>
          </section>
        )}

        {animationFilms.length > 0 && (
          <LandscapeRow titulo="Filmes de animação para toda a família" items={animationFilms.slice(0, 24).map((item) => toAnimationRow({ ...item, tipo: "filme" }))} />
        )}

        {studioRows.map((studio) => (
          <LazyRow key={studio.id}>
            <div id={`studio-${studio.id}`} className="scroll-mt-24">
              <LandscapeRow titulo={studio.name} items={studio.items} />
            </div>
          </LazyRow>
        ))}

        {avaliados.length > 0 && <LandscapeRow titulo="Mais Bem Avaliados"       items={avaliados.map(toRow)} verTodosHref="/desenhos?ordem=nota" />}
        {recentes.length > 0  && <LandscapeRow titulo="Adicionados Recentemente" items={recentes.map(toRow)}  verTodosHref="/desenhos?ordem=recente" />}
        {acao.length > 0      && <LazyRow><LandscapeRow titulo="Ação"     items={acao.map(toRow)}      verTodosHref="/genero/28" /></LazyRow>}
        {aventura.length > 0  && <LazyRow><LandscapeRow titulo="Aventura" items={aventura.map(toRow)}  verTodosHref="/genero/12" /></LazyRow>}
        {comedia.length > 0   && <LazyRow><LandscapeRow titulo="Comédia"  items={comedia.map(toRow)}   verTodosHref="/genero/35" /></LazyRow>}
        {familia.length > 0   && <LazyRow><LandscapeRow titulo="Família"  items={familia.map(toRow)}   verTodosHref="/genero/10751" /></LazyRow>}
        {animacao.length > 0  && <LazyRow><LandscapeRow titulo="Animação" items={animacao.map(toRow)}  verTodosHref="/genero/16" /></LazyRow>}
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
