export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit } from "@/lib/requestSecurity";
import { escolherProvedores } from "@/lib/ads/provedor";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/** `GET /api/ads/provedor` — qual rede de anúncios o aplicativo deve usar por formato (padrão: Unity e LevelPlay). Não concede nada. */
export async function GET(req: NextRequest) {
  const usuario = await getUserFromRequest(req);
  if (!usuario) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  const limite = await checkRateLimit(`ads-provedor:${usuario.userId}`, 30, 5 * 60);
  if (!limite.allowed) return NextResponse.json({ error: "Muitas tentativas" }, { status: 429, headers: NO_STORE });
  return NextResponse.json(escolherProvedores(), { headers: NO_STORE });
}
