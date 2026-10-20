export const dynamic = "force-dynamic";

import { type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { handleDownloadMetrics } from "@/lib/marketing/download-metrics-handler";

/**
 * GET /api/admin/marketing/download-metrics?days=7 — funil agregado da landing.
 * A guarda de admin fica visível aqui; a lógica (e os testes) vivem no handler.
 */
export function GET(req: NextRequest): Promise<Response> {
  return handleDownloadMetrics(req, { requireAdmin: (r) => requireAdmin(r) });
}
