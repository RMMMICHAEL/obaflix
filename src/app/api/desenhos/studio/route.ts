import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ANIMATION_STUDIOS, matchStudioTitles } from "@/lib/editorialCatalog";

export const dynamic = "force-dynamic";

const filmSelect = {
  id: true,
  titulo: true,
  tituloOriginal: true,
  poster: true,
  background: true, backgroundTituloPt: true,
  ano: true,
  nota: true,
} as const;

const seriesSelect = {
  id: true,
  titulo: true,
  tituloOriginal: true,
  poster: true,
  background: true, backgroundTituloPt: true,
  ano: true,
  nota: true,
  tipo: true,
} as const;

export async function GET(request: NextRequest) {
  const studioId = request.nextUrl.searchParams.get("studio");
  const studio = ANIMATION_STUDIOS.find((item) => item.id === studioId) ?? ANIMATION_STUDIOS[0];
  const titleFilters = studio.titles.flatMap((title) => ([
    { titulo: { startsWith: title, mode: "insensitive" as const } },
    { tituloOriginal: { startsWith: title, mode: "insensitive" as const } },
  ]));

  const [films, series] = await Promise.all([
    prisma.filme.findMany({
      where: {
        AND: [
          { generos: { some: { generoId: 16 } } },
          { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
          { OR: titleFilters },
        ],
      },
      orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
      take: 48,
      select: filmSelect,
    }),
    prisma.serie.findMany({
      where: {
        AND: [
          { OR: [{ generos: { some: { generoId: 16 } } }, { tipo: { in: ["anime", "desenho"] } }] },
          { episodios: { some: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] } } },
          { OR: titleFilters },
        ],
      },
      orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
      take: 32,
      select: seriesSelect,
    }),
  ]);

  const candidates = [
    ...films.map((item) => ({ ...item, tipo: "filme" as const })),
    ...series.map((item) => ({
      ...item,
      tipo: (item.tipo === "anime" ? "anime" : "desenho") as "anime" | "desenho",
    })),
  ];
  const items = matchStudioTitles(studio.titles, candidates).slice(0, 24).map((item) => ({
    id: item.id,
    tipo: item.tipo,
    titulo: item.titulo,
    poster: item.poster ?? null,
    background: item.background ?? null,
    backgroundTituloPt: item.backgroundTituloPt ?? null,
    ano: item.ano ?? null,
    nota: item.nota ?? null,
  }));

  return NextResponse.json(
    { studio: studio.id, items },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
  );
}
