import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const [lancamentosFilmes, lancamentosSeries, destaquesFilmes, destaquesSeries, animes, desenhos] =
    await Promise.all([
      prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.filme.findMany({ orderBy: { nota: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { nota: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: { nota: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: { nota: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
    ]);

  const hero = [...lancamentosFilmes, ...lancamentosSeries]
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  return NextResponse.json({ hero, lancamentosFilmes, lancamentosSeries, destaquesFilmes, destaquesSeries, animes, desenhos });
}
