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
  sinopse: true, ano: true, nota: true, urlDub: true, urlLeg: true, createdAt: true,
} as const;

const selHero = { id: true, titulo: true, sinopse: true, background: true } as const;

const selGrid = {
  id: true, titulo: true, poster: true, ano: true, nota: true,
  urlDub: true, urlLeg: true,
} as const;

function toRow(f: any) {
  return {
    id: f.id, tipo: "filme" as const, titulo: f.titulo,
    poster: f.poster ?? null, background: f.background ?? null, logo: f.logo ?? null,
    ano: f.ano ?? null, nota: f.nota ?? null,
    urlDub: f.urlDub ?? null, urlLeg: f.urlLeg ?? null,
    isNew: f.createdAt ? Date.now() - new Date(f.createdAt).getTime() < NEW_MS : false,
  };
}

function toGrid(f: any) {
  return {
    id: f.id, tipo: "filme" as const, titulo: f.titulo,
    poster: f.poster ?? null, ano: f.ano ?? null, nota: f.nota ?? null,
    urlDub: f.urlDub ?? null, urlLeg: f.urlLeg ?? null,
  };
}

export default async function FilmesPage({
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

  // Always fetch generos and anos for the FilterBar
  const [generos, anosRaw] = await Promise.all([
    prisma.genero.findMany({
      where: { filmes: { some: {} } },
      orderBy: { nome: "asc" },
    }),
    prisma.filme.findMany({
      where: { ano: { not: null } },
      select: { ano: true },
      distinct: ["ano"],
      orderBy: { ano: "desc" },
    }),
  ]);
  const anos = anosRaw.map((a) => a.ano!).filter(Boolean) as number[];

  if (isFiltered) {
    const where: any = {};
    if (generoId) where.generos = { some: { generoId } };
    if (ano) where.ano = ano;
    if (q) where.titulo = { contains: q, mode: "insensitive" };

    const orderBy: any =
      ordem === "nota"    ? { nota: "desc" }
      : ordem === "popular" ? [{ nota: "desc" }, { createdAt: "desc" }]
      : ordem === "az"      ? { titulo: "asc" }
      : ordem === "antigo"  ? { createdAt: "asc" }
      : { createdAt: "desc" };

    const [filmes, total] = await Promise.all([
      prisma.filme.findMany({ where, orderBy, skip, take: limit, select: selGrid }),
      prisma.filme.count({ where }),
    ]);
    const pages = Math.ceil(total / limit);

    return (
      <div className="min-h-screen pb-12 pt-20">
        <div className="px-4 md:px-8">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} total={total} pages={pages} label="filmes" />
          </Suspense>

          {filmes.length > 0 ? (
            <div className="mt-6 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
              {filmes.map((f) => (
                <ContentCard key={f.id} {...toGrid(f)} />
              ))}
            </div>
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    );
  }

  // Browse mode — hero + genre rows
  const [heroRaw, recentes, avaliados, acao, comedia, terror, ficcao, drama, crime, thriller, aventura] =
    await Promise.all([
      prisma.filme.findMany({ where: { background: { not: null } }, orderBy: { nota: "desc" }, take: 8, select: selHero }),
      prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 28 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 35 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 27 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 878 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 18 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 80 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 53 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
      prisma.filme.findMany({ where: { generos: { some: { generoId: 12 } } }, orderBy: { nota: "desc" }, take: 24, select: selBrowse }),
    ]);

  const heroItems = heroRaw.map((f) => ({
    id: f.id, tipo: "filme" as const,
    titulo: f.titulo, sinopse: f.sinopse ?? null,
    background: f.background!, trailerKey: null,
  }));

  return (
    <div className="min-h-screen pb-12">
      {heroItems.length > 0 && <HeroSlider items={heroItems} />}

      <div className={`mt-3 ${!heroItems.length ? "pt-20" : ""}`}>
        <ContinuarAssistindo />

        <div className="px-4 md:px-8 py-4">
          <Suspense fallback={<FilterBarSkeleton />}>
            <FilterBar generos={generos} anos={anos} label="filmes" />
          </Suspense>
        </div>

        {recentes.length > 0  && <LandscapeRow titulo="Adicionados Recentemente" items={recentes.map(toRow)} />}
        {avaliados.length > 0 && <LandscapeRow titulo="Mais Bem Avaliados"       items={avaliados.map(toRow)} />}
        {acao.length > 0      && <LandscapeRow titulo="Ação"                     items={acao.map(toRow)}      verTodosHref="/genero/28" />}
        {comedia.length > 0   && <LandscapeRow titulo="Comédia"                  items={comedia.map(toRow)}   verTodosHref="/genero/35" />}
        {terror.length > 0    && <LandscapeRow titulo="Terror"                   items={terror.map(toRow)}    verTodosHref="/genero/27" />}
        {ficcao.length > 0    && <LandscapeRow titulo="Ficção Científica"        items={ficcao.map(toRow)}    verTodosHref="/genero/878" />}
        {drama.length > 0     && <LandscapeRow titulo="Drama"                    items={drama.map(toRow)}     verTodosHref="/genero/18" />}
        {crime.length > 0     && <LandscapeRow titulo="Crime"                    items={crime.map(toRow)}     verTodosHref="/genero/80" />}
        {thriller.length > 0  && <LandscapeRow titulo="Thriller"                 items={thriller.map(toRow)}  verTodosHref="/genero/53" />}
        {aventura.length > 0  && <LandscapeRow titulo="Aventura"                 items={aventura.map(toRow)}  verTodosHref="/genero/12" />}
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
