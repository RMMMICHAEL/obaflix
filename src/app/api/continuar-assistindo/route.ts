export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/requestSecurity";

export async function GET(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json([]);

  const userId = usuario.userId;

  const history = await prisma.watchHistory.findMany({
    where: {
      userId,
      concluido: false,
      OR: [{ progressoSeg: { gt: 10 } }, { queued: true }],
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
          select: { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true },
        })
      : [],
    serieIds.length
      ? prisma.serie.findMany({
          where: { id: { in: serieIds } },
          select: { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true, tipo: true },
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
        background: content.background ?? null, logo: content.logo ?? null,
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

export async function DELETE(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const userId = usuario.userId;
  let body: { historyId?: unknown };
  try { body = await readJsonBody(req, 2048); }
  catch { return NextResponse.json({ error: "Dados inválidos" }, { status: 400 }); }
  const { historyId } = body;
  if (typeof historyId !== "string" || historyId.length > 128) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  await prisma.watchHistory.deleteMany({ where: { id: historyId, userId } });
  return NextResponse.json({ ok: true });
}
