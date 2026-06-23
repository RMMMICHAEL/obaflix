export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const userId = (session.user as { id: string }).id;
  const body = await req.json();
  const { conteudoId, conteudoTipo, episodioId, temporada, numeroEp, progressoSeg, duracaoSeg } = body;

  const concluido = duracaoSeg ? progressoSeg > duracaoSeg * 0.9 : false;

  await prisma.watchHistory.upsert({
    where: { userId_conteudoId_episodioId: { userId, conteudoId, episodioId: episodioId ?? null } },
    update: { progressoSeg, duracaoSeg, concluido, temporada, numeroEp },
    create: {
      userId,
      conteudoId,
      conteudoTipo,
      episodioId: episodioId ?? undefined,
      temporada,
      numeroEp,
      progressoSeg,
      duracaoSeg,
      concluido,
      filmeId: conteudoTipo === "filme" ? conteudoId : undefined,
      serieId: conteudoTipo === "serie" ? conteudoId : undefined,
    },
  });

  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const userId = (session.user as { id: string }).id;
  const conteudoId = req.nextUrl.searchParams.get("conteudoId");
  const episodioId = req.nextUrl.searchParams.get("episodioId");

  if (!conteudoId) return NextResponse.json({ error: "conteudoId obrigatório" }, { status: 400 });

  const progresso = await prisma.watchHistory.findUnique({
    where: { userId_conteudoId_episodioId: { userId, conteudoId, episodioId: episodioId ?? null } },
  });

  return NextResponse.json(progresso ?? { progressoSeg: 0, concluido: false });
}
