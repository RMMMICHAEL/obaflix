export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { espiarDesafio } from "@/lib/ads/concessoes";
import {
  chavePrivadaS2s,
  RecompensaEmAndamento,
  prepararRecompensa,
  receptorS2sAtivo,
  recompensaPlayerAtiva,
} from "@/lib/ads/recompensaLevelPlay";

/**
 * `POST /api/ads/levelplay/preparar` — "vou assistir um Rewarded para este desafio".
 *
 * Devolve o identificador temporário (`dynamicUserId`) que o app passa a `LevelPlay.setDynamicUserId()`
 * antes de `showAd`. Não concede nada: só prende o identificador a este usuário, a este desafio (e, por
 * ele, a conteúdo e finalidade) e trava o desafio no modo Rewarded. Só reprodução, só Android: download
 * e transmissão seguem pelo fluxo atual. Conta isenta nunca tem desafio, então nunca chega aqui.
 */
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

export interface DependenciasDePreparo {
  getUserFromRequest?: typeof getUserFromRequest;
  checkRateLimit?: typeof checkRateLimit;
  isIpBlocked?: typeof isIpBlocked;
  recordAbuseAttempt?: typeof recordAbuseAttempt;
  espiarDesafio?: typeof espiarDesafio;
  prepararRecompensa?: typeof prepararRecompensa;
  env?: Record<string, string | undefined>;
}

function createPrepararHandler(deps: DependenciasDePreparo = {}) {
  const usuarioDe = deps.getUserFromRequest ?? getUserFromRequest;
  const limitar = deps.checkRateLimit ?? checkRateLimit;
  const ipBloqueado = deps.isIpBlocked ?? isIpBlocked;
  const registrarAbuso = deps.recordAbuseAttempt ?? recordAbuseAttempt;
  const espiar = deps.espiarDesafio ?? espiarDesafio;
  const preparar = deps.prepararRecompensa ?? prepararRecompensa;

  return async function POST(req: NextRequest) {
    const env = deps.env ?? process.env;
    // Sem as duas flags e a chave não há como o evento chegar: travar o desafio só bloquearia o Interstitial.
    if (!recompensaPlayerAtiva(env) || !receptorS2sAtivo(env) || !chavePrivadaS2s(env)) {
      return NextResponse.json({ error: "Indisponível" }, { status: 404, headers: NO_STORE });
    }
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
    if (await ipBloqueado(ip)) return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });

    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && !headerMatchesHost(origin, host)) {
      await registrarAbuso(ip);
      return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
    }
    const usuario = await usuarioDe(req);
    if (!usuario) {
      await registrarAbuso(ip);
      return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
    }

    try {
      const limite = await limitar(`ads:lp:preparar:${usuario.userId}`, 20, 3600);
      if (!limite.allowed) return NextResponse.json({ error: "Muitas tentativas. Tente mais tarde" }, { status: 429, headers: NO_STORE });

      let corpo: { desafioId?: unknown };
      try {
        corpo = await readJsonBody<{ desafioId?: unknown }>(req, 1024);
      } catch {
        return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
      }
      const desafioId =
        typeof corpo?.desafioId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(corpo.desafioId.trim()) ? corpo.desafioId.trim() : null;
      if (!desafioId) return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });

      const desafio = await espiar(desafioId, usuario.userId);
      // Uma resposta só para inexistente, de outra conta, de outra finalidade ou de outra plataforma.
      if (!desafio || desafio.finalidade !== "reproducao" || (desafio.plataforma !== "android" && desafio.plataforma !== "android_nativo")) {
        await registrarAbuso(ip);
        return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
      }
      const { dynamicUserId } = await preparar({ userId: usuario.userId, desafioId });
      return NextResponse.json({ dynamicUserId }, { headers: NO_STORE });
    } catch (e) {
      // Um Rewarded pendente por conta: o segundo desafio espera o primeiro terminar ou expirar.
      if (e instanceof RecompensaEmAndamento) {
        return NextResponse.json({ error: "Já há um anúncio em andamento", codigo: "recompensa_em_andamento" }, { status: 409, headers: NO_STORE });
      }
      return NextResponse.json({ error: "Serviço temporariamente indisponível" }, { status: 503, headers: NO_STORE });
    }
  };
}

export const POST = Object.assign(createPrepararHandler(), { createForTest: createPrepararHandler });
