import { prisma } from "@/lib/prisma";

export type ContinueWatchingItem = {
  historyId: string;
  id: string;
  tipo: string;
  titulo: string;
  poster: string | null;
  background: string | null;
  ano: number | null;
  nota: number | null;
  progressoSeg: number;
  duracaoSeg: number | null;
  temporada: number | null;
  numeroEp: number | null;
  episodioId: string | null;
  queued: boolean;
};

export async function getContinueWatchingItems(userId: string): Promise<ContinueWatchingItem[]> {
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

  if (!history.length) return [];

  const movieIds = [...new Set(history.filter((item) => item.conteudoTipo === "filme").map((item) => item.conteudoId))];
  const seriesIds = [...new Set(history.filter((item) => item.conteudoTipo === "serie").map((item) => item.conteudoId))];

  const [movies, series] = await Promise.all([
    movieIds.length
      ? prisma.filme.findMany({
          where: { id: { in: movieIds } },
          select: { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true },
        })
      : [],
    seriesIds.length
      ? prisma.serie.findMany({
          where: { id: { in: seriesIds } },
          select: { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true },
        })
      : [],
  ]);

  const movieMap = new Map(movies.map((item) => [item.id, item]));
  const seriesMap = new Map(series.map((item) => [item.id, item]));

  return history.flatMap((item) => {
    const content = item.conteudoTipo === "filme"
      ? movieMap.get(item.conteudoId)
      : seriesMap.get(item.conteudoId);
    if (!content) return [];
    return [{
      historyId: item.id,
      id: content.id,
      tipo: item.conteudoTipo,
      titulo: content.titulo,
      poster: content.poster,
      background: content.background ?? null,
      ano: content.ano ?? null,
      nota: content.nota ?? null,
      progressoSeg: item.progressoSeg,
      duracaoSeg: item.duracaoSeg,
      temporada: item.temporada,
      numeroEp: item.numeroEp,
      episodioId: item.episodioId,
      queued: item.queued,
    }];
  });
}
