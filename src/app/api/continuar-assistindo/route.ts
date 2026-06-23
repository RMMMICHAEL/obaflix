export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json([]);

  const userId = (session.user as { id: string }).id;

  const history = await prisma.watchHistory.findMany({
    where: { userId, concluido: false, progressoSeg: { gt: 30 } },
    orderBy: { updatedAt: "desc" },
    take: 24,
    include: {
      filme: { select: { id: true, titulo: true, poster: true, ano: true, nota: true } },
      serie: { select: { id: true, titulo: true, poster: true, ano: true, nota: true, tipo: true } },
    },
  });

  const items = history
    .map((h) => {
      const content = h.filme ?? h.serie;
      if (!content) return null;
      return {
        historyId: h.id,
        id: content.id,
        tipo: h.conteudoTipo as string,
        titulo: content.titulo,
        poster: content.poster,
        ano: (content as any).ano ?? null,
        nota: (content as any).nota ?? null,
        progressoSeg: h.progressoSeg,
        duracaoSeg: h.duracaoSeg,
        temporada: h.temporada,
        numeroEp: h.numeroEp,
        episodioId: h.episodioId,
      };
    })
    .filter(Boolean);

  return NextResponse.json(items);
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const userId = (session.user as { id: string }).id;
  const { historyId } = await req.json();

  await prisma.watchHistory.deleteMany({ where: { id: historyId, userId } });
  return NextResponse.json({ ok: true });
}
