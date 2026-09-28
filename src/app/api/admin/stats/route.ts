export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isLegacyAdminTokenRequest, requireAdmin } from "@/lib/auth";
import { dashboardWindows, usersPerDay } from "@/lib/admin-dashboard";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req); if (guard) return guard;

  const [filmes, series, animes, desenhos, episodios, usuarios] = await Promise.all([
    prisma.filme.count(),
    prisma.serie.count({ where: { tipo: "serie" } }),
    prisma.serie.count({ where: { tipo: "anime" } }),
    prisma.serie.count({ where: { tipo: "desenho" } }),
    prisma.episodio.count(),
    prisma.user.count(),
  ]);

  // Token legado (produtores de catálogo): mesma resposta de antes, sem
  // assinaturas, cadastros por dia nem telemetria — isso é só da sessão admin.
  if (isLegacyAdminTokenRequest(req)) {
    return NextResponse.json({ filmes, series, animes, desenhos, episodios, usuarios });
  }

  const now = new Date();
  const { startToday, sevenDaysAgo, thirtyDaysAgo, inSevenDays } = dashboardWindows(now);

  const [novosHoje, novos7Dias, novos30Dias, assinaturasAtivas, vencendo7Dias, canais, canaisAtivos, recentUsers, syncRuns] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: startToday } } }),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.assinatura.count({ where: { status: "ATIVA", iniciaEm: { lte: now }, terminaEm: { gt: now } } }),
    prisma.assinatura.count({ where: { status: "ATIVA", terminaEm: { gt: now, lte: inSevenDays } } }),
    prisma.canal.count(),
    prisma.canal.count({ where: { ativo: true } }),
    prisma.user.findMany({ where: { createdAt: { gte: thirtyDaysAgo } }, select: { createdAt: true } }),
    prisma.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 40 }),
  ]);

  const latestSync = new Map<string, typeof syncRuns[number]>();
  for (const run of syncRuns) {
    const key = `${run.source}:${run.job}`;
    if (!latestSync.has(key)) latestSync.set(key, run);
  }
  return NextResponse.json({
    filmes, series, animes, desenhos, episodios, usuarios,
    novosHoje, novos7Dias, novos30Dias, assinaturasAtivas, vencendo7Dias,
    canais, canaisAtivos,
    usuariosPorDia: usersPerDay(recentUsers.map((user) => user.createdAt), now),
    sincronizacoes: [...latestSync.values()],
  });
}
