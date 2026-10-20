/**
 * Lógica de `GET /api/admin/marketing/download-metrics`, fora do arquivo de rota
 * (o Next só deixa `route.ts` exportar handlers conhecidos) e com a guarda de
 * admin injetável para teste. `days` só aceita 1, 7 ou 30. Devolve o funil já
 * agregado — nunca linhas cruas desnecessárias — e sem a palavra "install".
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  ALLOWED_DAYS,
  aggregateDownloadMetrics,
  loadMetricsSince,
  windowStart,
  type MetricRow,
} from "./landing-metrics";

export type DownloadMetricsDeps = {
  // Mais permissivo que `typeof requireAdmin` (NextResponse é um Response) para
  // aceitar tanto a guarda real quanto fakes de teste.
  requireAdmin?: (req: NextRequest) => Promise<Response | null>;
  loadRows?: (from: Date) => Promise<MetricRow[]>;
  now?: number;
};

export async function handleDownloadMetrics(req: NextRequest, deps: DownloadMetricsDeps = {}): Promise<Response> {
  const guard = await (deps.requireAdmin ?? requireAdmin)(req);
  if (guard) return guard;

  const raw = new URL(req.url).searchParams.get("days") ?? "7";
  const days = Number(raw);
  if (!(ALLOWED_DAYS as readonly number[]).includes(days)) {
    return NextResponse.json({ error: "Parâmetro days inválido" }, { status: 400 });
  }

  const now = deps.now ?? Date.now();
  const rows = await (deps.loadRows ?? loadMetricsSince)(windowStart(days, now));
  return NextResponse.json(aggregateDownloadMetrics(rows, days, now));
}
