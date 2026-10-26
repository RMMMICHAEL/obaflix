export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit } from "@/lib/requestSecurity";
import {
  chavePrivadaS2s,
  identidadeDoLevelPlay,
  receptorS2sAtivo,
  recompensaPlayerAtiva,
} from "@/lib/ads/recompensaLevelPlay";

/**
 * `GET /api/ads/levelplay/identidade` — o `USER_ID` opaco desta conta no LevelPlay.
 *
 * O app o entrega a `LevelPlayInitRequest.withUserId` **antes** do `init`: é o único valor que a assinatura
 * oficial do callback cobre. Estável por conta, emitido só para a própria conta autenticada, sem e-mail nem id
 * interno. Não concede nada.
 */
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

export interface DependenciasDeIdentidade {
  getUserFromRequest?: typeof getUserFromRequest;
  checkRateLimit?: typeof checkRateLimit;
  identidadeDoLevelPlay?: typeof identidadeDoLevelPlay;
  env?: Record<string, string | undefined>;
}

function createIdentidadeHandler(deps: DependenciasDeIdentidade = {}) {
  const usuarioDe = deps.getUserFromRequest ?? getUserFromRequest;
  const limitar = deps.checkRateLimit ?? checkRateLimit;
  const identidade = deps.identidadeDoLevelPlay ?? identidadeDoLevelPlay;

  return async function GET(req: NextRequest) {
    const env = deps.env ?? process.env;
    if (!recompensaPlayerAtiva(env) || !receptorS2sAtivo(env) || !chavePrivadaS2s(env)) {
      return NextResponse.json({ error: "Indisponível" }, { status: 404, headers: NO_STORE });
    }
    const usuario = await usuarioDe(req);
    if (!usuario) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
    try {
      const limite = await limitar(`ads:lp:identidade:${usuario.userId}`, 30, 3600);
      if (!limite.allowed) return NextResponse.json({ error: "Muitas tentativas. Tente mais tarde" }, { status: 429, headers: NO_STORE });
      return NextResponse.json({ userId: await identidade(usuario.userId) }, { headers: NO_STORE });
    } catch {
      return NextResponse.json({ error: "Serviço temporariamente indisponível" }, { status: 503, headers: NO_STORE });
    }
  };
}

export const GET = Object.assign(createIdentidadeHandler(), { createForTest: createIdentidadeHandler });
