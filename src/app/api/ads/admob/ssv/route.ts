export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { processarSsvDoAdMob } from "@/lib/ads/admobSsv";

/**
 * `GET /api/ads/admob/ssv` — verificação do lado do servidor do Rewarded do AdMob (servidor→servidor).
 * Sem sessão: a prova é a assinatura ECDSA do Google. Só grava o recibo; a concessão continua em `/api/ads/complete`.
 */
export async function GET(req: NextRequest) {
  const r = await processarSsvDoAdMob({ queryBruta: new URL(req.url).search, agora: Date.now() });
  try {
    // Só o motivo e o status: nenhum valor recebido (assinatura, ids) vai para o log.
    console.log(JSON.stringify({ evento: "admob_ssv", status: r.status, ack: r.ack, motivo: r.motivo ?? (r.ack ? "ok" : r.corpo) }));
  } catch { /* log nunca derruba a resposta */ }
  return new NextResponse(r.corpo, {
    status: r.status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
