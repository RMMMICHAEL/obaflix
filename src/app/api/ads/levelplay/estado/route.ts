export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit } from "@/lib/requestSecurity";
import { estadoDaRecompensa, receptorS2sAtivo, recompensaPlayerAtiva } from "@/lib/ads/recompensaLevelPlay";

/**
 * `GET /api/ads/levelplay/estado?desafioId=` — "o servidor já recebeu a confirmação do LevelPlay?".
 *
 * Só leitura, com limite próprio (o cliente consulta em intervalo curto e `/ads/complete` tem teto baixo).
 * `confirmada: true` não libera nada: quem emite a concessão é `/api/ads/complete`.
 */
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

export interface DependenciasDeEstado {
  getUserFromRequest?: typeof getUserFromRequest;
  checkRateLimit?: typeof checkRateLimit;
  estadoDaRecompensa?: typeof estadoDaRecompensa;
  env?: Record<string, string | undefined>;
}

function createEstadoHandler(deps: DependenciasDeEstado = {}) {
  const usuarioDe = deps.getUserFromRequest ?? getUserFromRequest;
  const limitar = deps.checkRateLimit ?? checkRateLimit;
  const estado = deps.estadoDaRecompensa ?? estadoDaRecompensa;

  return async function GET(req: NextRequest) {
    const env = deps.env ?? process.env;
    if (!recompensaPlayerAtiva(env) || !receptorS2sAtivo(env)) {
      return NextResponse.json({ error: "Indisponível" }, { status: 404, headers: NO_STORE });
    }
    const usuario = await usuarioDe(req);
    if (!usuario) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
    const desafioId = req.nextUrl.searchParams.get("desafioId") ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(desafioId)) {
      return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
    }
    try {
      const limite = await limitar(`ads:lp:estado:${usuario.userId}`, 240, 3600);
      if (!limite.allowed) return NextResponse.json({ error: "Muitas tentativas. Tente mais tarde" }, { status: 429, headers: NO_STORE });
      return NextResponse.json(await estado({ userId: usuario.userId, desafioId }), { headers: NO_STORE });
    } catch {
      return NextResponse.json({ error: "Serviço temporariamente indisponível" }, { status: 503, headers: NO_STORE });
    }
  };
}

export const GET = Object.assign(createEstadoHandler(), { createForTest: createEstadoHandler });
