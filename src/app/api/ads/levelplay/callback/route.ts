export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { processarCallbackLevelPlay } from "@/lib/ads/recompensaLevelPlay";

/**
 * `GET /api/ads/levelplay/callback` — callback servidor→servidor do LevelPlay (Rewarded).
 *
 * Sem sessão: a prova é a assinatura MD5 com a chave privada do app, mais a origem na lista oficial de IPs.
 * Responde `EVENT_ID:OK` só depois de persistir o recibo; isso **não** concede reprodução. A concessão
 * continua em `/api/ads/complete`, que exige este recibo. Nada de chave, URL do painel ou credencial no código.
 */
export interface DependenciasDoCallback {
  processar?: typeof processarCallbackLevelPlay;
  agora?: () => number;
  env?: Record<string, string | undefined>;
}

function createCallbackHandler(deps: DependenciasDoCallback = {}) {
  const processar = deps.processar ?? processarCallbackLevelPlay;
  return async function GET(req: NextRequest) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
    const r = await processar({ query: req.nextUrl.searchParams, ip, agora: (deps.agora ?? Date.now)(), env: deps.env });
    return new NextResponse(r.corpo, {
      status: r.status,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  };
}

export const GET = Object.assign(createCallbackHandler(), { createForTest: createCallbackHandler });
