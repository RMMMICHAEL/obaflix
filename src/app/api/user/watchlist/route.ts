export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = (session.user as { id: string }).id;

  const watchlist = await prisma.watchlist.findMany({
    where: { userId },
    include: {
      filme: { include: { generos: { include: { genero: true } } } },
      serie: { include: { generos: { include: { genero: true } } } },
    },
    orderBy: { addedAt: "desc" },
  });

  return NextResponse.json(watchlist);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { conteudoId, conteudoTipo } = await req.json();

  await prisma.watchlist.upsert({
    where: { userId_conteudoId_conteudoTipo: { userId, conteudoId, conteudoTipo } },
    update: {},
    create: {
      userId,
      conteudoId,
      conteudoTipo,
      filmeId: conteudoTipo === "filme" ? conteudoId : undefined,
      serieId: conteudoTipo === "serie" ? conteudoId : undefined,
    },
  });

  return NextResponse.json({ ok: true });
}
