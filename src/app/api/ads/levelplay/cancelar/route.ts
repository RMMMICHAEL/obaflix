export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { cancelarRecompensa, receptorS2sAtivo, recompensaPlayerAtiva } from "@/lib/ads/recompensaLevelPlay";

/**
 * `POST /api/ads/levelplay/cancelar` — "desisti deste Rewarded".
 *
 * Libera o slot de Rewarded pendente da conta para uma nova tentativa. Não concede nada, não destrava o
 * desafio e não faz nada se o recibo já chegou. Só o dono do pendente consegue.
 */
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

export interface DependenciasDeCancelamento {
  getUserFromRequest?: typeof getUserFromRequest;
  checkRateLimit?: typeof checkRateLimit;
  cancelarRecompensa?: typeof cancelarRecompensa;
  env?: Record<string, string | undefined>;
}

function createCancelarHandler(deps: DependenciasDeCancelamento = {}) {
  const usuarioDe = deps.getUserFromRequest ?? getUserFromRequest;
  const limitar = deps.checkRateLimit ?? checkRateLimit;
  const cancelar = deps.cancelarRecompensa ?? cancelarRecompensa;

  return async function POST(req: NextRequest) {
    const env = deps.env ?? process.env;
    if (!recompensaPlayerAtiva(env) || !receptorS2sAtivo(env)) {
      return NextResponse.json({ error: "Indisponível" }, { status: 404, headers: NO_STORE });
    }
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && !headerMatchesHost(origin, host)) {
      return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
    }
    const usuario = await usuarioDe(req);
    if (!usuario) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
    try {
      const limite = await limitar(`ads:lp:cancelar:${usuario.userId}`, 60, 3600);
      if (!limite.allowed) return NextResponse.json({ error: "Muitas tentativas. Tente mais tarde" }, { status: 429, headers: NO_STORE });
      let corpo: { desafioId?: unknown };
      try {
        corpo = await readJsonBody<{ desafioId?: unknown }>(req, 1024);
      } catch {
        return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
      }
      const desafioId = typeof corpo?.desafioId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(corpo.desafioId.trim()) ? corpo.desafioId.trim() : null;
      if (!desafioId) return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
      return NextResponse.json(await cancelar({ userId: usuario.userId, desafioId }), { headers: NO_STORE });
    } catch {
      return NextResponse.json({ error: "Serviço temporariamente indisponível" }, { status: 503, headers: NO_STORE });
    }
  };
}

export const POST = Object.assign(createCancelarHandler(), { createForTest: createCancelarHandler });
