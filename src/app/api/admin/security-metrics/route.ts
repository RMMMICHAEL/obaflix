export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSnapshot, getSeries } from "@/lib/metrics";
import { isRedisConnected } from "@/lib/redis";

/**
 * GET /api/admin/security-metrics
 * Query params:
 *   hours   — janela de agregação em horas (padrão: 24, máx: 720 = 30d)
 *   series  — se "1", inclui série horária dos últimos N horas (pesado — use com moderação)
 *   metric  — métrica específica para a série (ex: stream_started, auth_failure)
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const params = req.nextUrl.searchParams;
  const hours = Math.min(720, Math.max(1, parseInt(params.get("hours") ?? "24", 10)));
  const includeSeries = params.get("series") === "1";
  const seriesMetric = params.get("metric") ?? "stream_started";

  const [snapshot, serie] = await Promise.all([
    getSnapshot(hours),
    includeSeries ? getSeries(seriesMetric, hours) : Promise.resolve(undefined),
  ]);

  return NextResponse.json({
    window: { hours, from: new Date(Date.now() - hours * 3600 * 1000).toISOString(), to: new Date().toISOString() },
    redis: isRedisConnected(),
    snapshot,
    ...(serie ? { serie: { metric: seriesMetric, data: serie } } : {}),
  });
}
