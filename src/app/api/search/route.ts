import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const tipo = req.nextUrl.searchParams.get("tipo");

  if (!q) return NextResponse.json({ filmes: [], series: [] });

  const [filmes, series] = await Promise.all([
    tipo === "serie" ? [] : prisma.filme.findMany({
      where: { titulo: { contains: q, mode: "insensitive" } },
      take: 20,
      include: { generos: { include: { genero: true } } },
    }),
    tipo === "filme" ? [] : prisma.serie.findMany({
      where: {
        titulo: { contains: q, mode: "insensitive" },
        ...(tipo ? { tipo } : {}),
      },
      take: 20,
      include: { generos: { include: { genero: true } } },
    }),
  ]);

  return NextResponse.json({ filmes, series });
}
