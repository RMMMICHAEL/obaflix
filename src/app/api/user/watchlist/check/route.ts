import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const userId = (session.user as { id: string }).id;
  const { searchParams } = req.nextUrl;
  const conteudoId = searchParams.get("conteudoId");
  const conteudoTipo = searchParams.get("conteudoTipo");
  if (!conteudoId || !conteudoTipo) return NextResponse.json({ inWatchlist: false });

  const item = await prisma.watchlist.findUnique({
    where: { userId_conteudoId_conteudoTipo: { userId, conteudoId, conteudoTipo } },
    select: { userId: true },
  });
  return NextResponse.json({ inWatchlist: !!item });
}
