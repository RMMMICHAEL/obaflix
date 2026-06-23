export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

export async function GET(_req: NextRequest) {
  const guard = await requireAdmin(); if (guard) return guard;

  const [filmes, series, animes, desenhos, episodios, usuarios] = await Promise.all([
    prisma.filme.count(),
    prisma.serie.count({ where: { tipo: "serie" } }),
    prisma.serie.count({ where: { tipo: "anime" } }),
    prisma.serie.count({ where: { tipo: "desenho" } }),
    prisma.episodio.count(),
    prisma.user.count(),
  ]);

  return NextResponse.json({ filmes, series, animes, desenhos, episodios, usuarios });
}
