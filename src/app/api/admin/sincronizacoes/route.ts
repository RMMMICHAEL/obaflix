import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sanitizeErrorSummary, summarizeSyncSources, type SyncRunLike } from "@/lib/sync-sources";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdminSession(req); if (guard) return guard;
  const [runs, legacy] = await Promise.all([
    prisma.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 200 }),
    prisma.syncMetric.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
  ]);
  // SyncMetric (legado) vira o mesmo formato, marcado como `legacy`.
  const legacyRuns: SyncRunLike[] = legacy.map((metric) => ({
    id: metric.id,
    source: metric.source,
    job: metric.job,
    status: metric.ok ? "SUCCESS" : "FAILED",
    startedAt: metric.startedAt,
    finishedAt: new Date(metric.startedAt.getTime() + metric.durationMs),
    errors: metric.errors,
    errorSummary: sanitizeErrorSummary(metric.errorMessage),
    legacy: true,
  }));
  const all = [...runs, ...legacyRuns].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  const { fontes, outras } = summarizeSyncSources(all, new Date());
  return NextResponse.json({ fontes, outras, recent: runs.slice(0, 30) });
}
