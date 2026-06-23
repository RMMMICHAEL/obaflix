export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function isAdmin(req: NextRequest) {
  return req.headers.get("x-admin-token") === process.env.ADMIN_SECRET_TOKEN;
}

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

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
