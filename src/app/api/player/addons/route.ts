export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { headerMatchesHost, readJsonBody, checkRateLimit } from "@/lib/requestSecurity";
import { alvoAddonDaSessao } from "@/lib/fontes";
import { autorizarCatalogo } from "@/lib/playbackAuthorization";
import { autorizarAddon } from "@/lib/playerAddons";
import { getAddonImdbId } from "@/lib/tmdb";

const headers = { "Cache-Control": "no-store, private" };

/** Só traduz a sessão autorizada. URLs e mídia dos addons não passam pelo servidor. */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin || !headerMatchesHost(origin, req.headers.get("host") || "")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers });
  }
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: "Não autenticado" }, { status: 401, headers });
  try {
    const body = await readJsonBody<{ sessao?: unknown }>(req, 1024);
    if (typeof body.sessao !== "string" || !/^[\w-]{16,64}$/.test(body.sessao)) {
      return NextResponse.json({ error: "Sessão inválida" }, { status: 400, headers });
    }
    if (!(await checkRateLimit("addons:" + user.userId, 30, 60)).allowed) {
      return NextResponse.json({ error: "Muitas solicitações" }, { status: 429, headers });
    }
    const alvo = await alvoAddonDaSessao(body.sessao, user.userId);
    const result = await autorizarAddon(alvo, tipo => autorizarCatalogo(user.userId, tipo), getAddonImdbId);
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: "Sessão sem autorização ou identificador compatível para addons" }, { status: 403, headers });
  }
}
