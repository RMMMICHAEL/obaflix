import { Suspense } from "react";
import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";
import { ContentCard } from "@/components/ui/ContentCard";
import { FilterBar } from "@/components/ui/FilterBar";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const NEW_MS = 3 * 24 * 60 * 60 * 1000;

const selBrowse = {
  id: true, titulo: true, poster: true, background: true, logo: true,
  sinopse: true, ano: true, nota: true, createdAt: true,
} as const;

const selHero = { id: true, titulo: true, sinopse: true, background: true } as const;

const selGrid = {
  id: true, titulo: true, poster: true, ano: true, nota: true,
} as const;

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
  const anos = anosRaw.map((a) => a.ano!).filter(Boolean) as number[];

  if (isFiltered) {
    const where: any = { tipo: "desenho" };
    if (generoId) where.generos = { some: { generoId } };
    if (ano) where.ano = ano;
    if (q) where.titulo = { contains: q, mode: "insensitive" };

    const orderBy: any =
      ordem === "nota"    ? { nota: "desc" }
      : ordem === "popular" ? [{ nota: "desc" }, { createdAt: "desc" }]
      : ordem === "az"      ? { titulo: "asc" }
      : ordem === "antigo"  ? { createdAt: "asc" }
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
  const [heroRaw, avaliados, recentes, acao, aventura, comedia, familia, animacao] =
    await Promise.all([
      prisma.serie.findMany({ where: { tipo: "desenho", background: { not: null } }, orderBy: { nota: "desc" }, take: 8, select: selHero }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { createdAt: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 28 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 12 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 10751 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.serie.findMany({ where: { tipo: "desenho", generos: { some: { generoId: 16 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    ]);

  const heroItems = heroRaw.map((s) => ({
    id: s.id, tipo: "desenho" as const,
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
            <FilterBar generos={generos} anos={anos} label="desenhos" />
          </Suspense>
        </div>

        {avaliados.length > 0 && <LandscapeRow titulo="Mais Bem Avaliados"       items={avaliados.map(toRow)} />}
        {recentes.length > 0  && <LandscapeRow titulo="Adicionados Recentemente" items={recentes.map(toRow)}  />}
        {acao.length > 0      && <LandscapeRow titulo="Ação"                     items={acao.map(toRow)}      verTodosHref="/genero/28" />}
        {aventura.length > 0  && <LandscapeRow titulo="Aventura"                 items={aventura.map(toRow)}  verTodosHref="/genero/12" />}
        {comedia.length > 0   && <LandscapeRow titulo="Comédia"                  items={comedia.map(toRow)}   verTodosHref="/genero/35" />}
        {familia.length > 0   && <LandscapeRow titulo="Família"                  items={familia.map(toRow)}   verTodosHref="/genero/10751" />}
        {animacao.length > 0  && <LandscapeRow titulo="Animação"                 items={animacao.map(toRow)}  verTodosHref="/genero/16" />}
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
