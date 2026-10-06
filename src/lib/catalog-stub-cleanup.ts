import { Prisma, type PrismaClient } from "@prisma/client";
import { FILME_STUB_SEM_PLAYER, SERIE_STUB_SEM_PLAYER } from "./catalog-availability";

/** Só stubs sem fontes. Serialização impede apagar conteúdo recebido em paralelo. */
export async function cleanupCatalogStubs(db: PrismaClient): Promise<{ filmes: number; series: number }> {
  return db.$transaction(async tx => {
    const [filmes, series] = await Promise.all([
      tx.filme.findMany({ where: FILME_STUB_SEM_PLAYER, select: { id: true } }),
      tx.serie.findMany({ where: SERIE_STUB_SEM_PLAYER, select: { id: true } }),
    ]);
    // LIKE usado pelo Prisma pode interpretar '_' como wildcard: confirmar
    // o prefixo literal antes de remover qualquer relação ou registro.
    const filmeIds = filmes.map(f => f.id).filter(id => id.startsWith("tmdb_"));
    const serieIds = series.map(s => s.id).filter(id => id.startsWith("tmdb_"));
    // Relações obrigatórias não têm cascade: removê-las junto evita falha de FK.
    // Watchlist/histórico com FK opcional seguem o SetNull existente do schema.
    await tx.filmeGenero.deleteMany({ where: { filmeId: { in: filmeIds } } });
    await tx.serieGenero.deleteMany({ where: { serieId: { in: serieIds } } });
    await tx.episodio.deleteMany({ where: { serieId: { in: serieIds } } });
    // PopularHistory não tem FK: remover somente histórico de ranking dos
    // candidatos exatos, incluindo o tipo para não atingir outro conteúdo.
    await tx.popularHistory.deleteMany({ where: { OR: [
      { conteudoTipo: "filme", conteudoId: { in: filmeIds } },
      { conteudoTipo: "serie", conteudoId: { in: serieIds } },
    ] } });
    const f = await tx.filme.deleteMany({ where: { AND: [FILME_STUB_SEM_PLAYER, { id: { in: filmeIds } }] } });
    const s = await tx.serie.deleteMany({ where: { AND: [SERIE_STUB_SEM_PLAYER, { id: { in: serieIds } }] } });
    return { filmes: f.count, series: s.count };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
