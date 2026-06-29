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
    where: {
      userId,
      concluido: false,
      OR: [{ progressoSeg: { gt: 30 } }, { queued: true }],
    },
    orderBy: { updatedAt: "desc" },
    take: 24,
    select: {
      id: true,
      conteudoId: true,
      conteudoTipo: true,
      progressoSeg: true,
      duracaoSeg: true,
      temporada: true,
      numeroEp: true,
      episodioId: true,
      queued: true,
    },
  });

  if (history.length === 0) return NextResponse.json([]);

  // Busca dados de filmes e séries por conteudoId (não via FK, que pode ser null em registros antigos)
  const filmeIds = [...new Set(history.filter((h) => h.conteudoTipo === "filme").map((h) => h.conteudoId))];
  const serieIds = [...new Set(history.filter((h) => h.conteudoTipo === "serie").map((h) => h.conteudoId))];

  const [filmes, series] = await Promise.all([
    filmeIds.length
      ? prisma.filme.findMany({
          where: { id: { in: filmeIds } },
          select: { id: true, titulo: true, poster: true, background: true, ano: true, nota: true },
        })
      : [],
    serieIds.length
      ? prisma.serie.findMany({
          where: { id: { in: serieIds } },
          select: { id: true, titulo: true, poster: true, background: true, ano: true, nota: true, tipo: true },
        })
      : [],
  ]);

  const filmeMap = new Map(filmes.map((f) => [f.id, f]));
  const serieMap = new Map(series.map((s) => [s.id, s]));

  const items = history
    .map((h) => {
      const content =
        h.conteudoTipo === "filme"
          ? filmeMap.get(h.conteudoId)
          : serieMap.get(h.conteudoId);
      if (!content) return null;
      return {
        historyId: h.id,
        id: content.id,
        tipo: h.conteudoTipo,
        titulo: content.titulo,
        poster: content.poster,
        background: content.background ?? null,
        ano: content.ano ?? null,
        nota: content.nota ?? null,
        progressoSeg: h.progressoSeg,
        duracaoSeg: h.duracaoSeg,
        temporada: h.temporada,
        numeroEp: h.numeroEp,
        episodioId: h.episodioId,
        queued: h.queued,
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
