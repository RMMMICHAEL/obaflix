export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { monetizacaoAtiva } from "@/lib/playbackAuthorization";
import { iniciarPromocao } from "@/lib/ads/concessoes";
import { hostParaLog } from "@/lib/ads/directLink";

/**
 * `POST /api/ads/promocao/iniciar` — "a pessoa escolheu assistir gratuitamente".
 *
 * Só a Android TV chega aqui, e só com um desafio de promoção que
 * `/api/playback/authorize` abriu para **esta** conta e **este** aparelho.
 *
 * ## O que esta rota faz
 *
 * Grava, pelo relógio do servidor, o instante em que a sessão promocional
 * começou, e devolve o endereço do vídeo congelado no desafio. A conclusão, em
 * `/api/ads/complete`, só emite concessão se entre este instante e ela passar ao
 * menos a duração do vídeo — que também veio do servidor.
 *
 * ## O que ela não faz
 *
 * Não emite concessão, não consome o desafio e não libera mídia do catálogo. O
 * vídeo devolvido é a nossa promoção, não o conteúdo pedido.
 *
 * ## Repetição
 *
 * O início é `SET NX`. Um retry de rede, ou o "tentar de novo" depois de o vídeo
 * falhar ao carregar, recebe o mesmo vídeo e mantém o instante original — nunca
 * reinicia a contagem e nunca cria um segundo início.
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
const LIMITE_DO_CORPO = 512;

/** Iniciar é barato, mas em série não deve ser — mesmo teto de `/ads/complete`. */
const LIMITE_POR_CONTA = 20;
const JANELA_SEGUNDOS = 3600;

export interface DependenciasDeInicio {
  getUserFromRequest?: typeof getUserFromRequest;
  monetizacaoAtiva?: () => boolean;
  checkRateLimit?: typeof checkRateLimit;
  iniciarPromocao?: typeof iniciarPromocao;
  isIpBlocked?: typeof isIpBlocked;
  recordAbuseAttempt?: typeof recordAbuseAttempt;
  agora?: () => number;
}

function createIniciarPromocaoHandler(deps: DependenciasDeInicio = {}) {
  const usuarioDaRequisicao = deps.getUserFromRequest ?? getUserFromRequest;
  const flagAtiva = deps.monetizacaoAtiva ?? monetizacaoAtiva;
  const limitar = deps.checkRateLimit ?? checkRateLimit;
  const iniciar = deps.iniciarPromocao ?? iniciarPromocao;
  const ipBloqueado = deps.isIpBlocked ?? isIpBlocked;
  const registrarAbuso = deps.recordAbuseAttempt ?? recordAbuseAttempt;
  const agora = deps.agora ?? Date.now;

  return async function POST(req: NextRequest) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    const ua = req.headers.get("user-agent") || "unknown";

    if (await ipBloqueado(ip)) {
      return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
    }

    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && !headerMatchesHost(origin, host)) {
      await registrarAbuso(ip);
      audit("origin_rejected", { ip, ua, detail: "/ads/promocao/iniciar" });
      return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
    }

    const usuario = await usuarioDaRequisicao(req);
    if (!usuario) {
      await registrarAbuso(ip);
      audit("auth_failure", { ip, ua, detail: "/ads/promocao/iniciar sem sessão" });
      return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
    }
    const userId = usuario.userId;

    // Mesmo motivo de `/ads/complete`: com o enforcement desligado ninguém
    // recebe desafio, e responder aqui só pré-fabricaria estado.
    if (!flagAtiva()) {
      return NextResponse.json({ error: "Indisponível" }, { status: 404, headers: NO_STORE });
    }

    // Só a credencial de TV. Um cookie da mesma conta não inicia a promoção do
    // aparelho — e o desafio ainda confere o `deviceId` exato abaixo.
    if (usuario.origem !== "bearer" || !usuario.deviceId) {
      audit("playback_negado", { userId, ip, ua, detail: "/ads/promocao/iniciar fora da TV" });
      return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
    }

    try {
      const limite = await limitar(`ads:promocao:${userId}`, LIMITE_POR_CONTA, JANELA_SEGUNDOS);
      if (!limite.allowed) {
        audit("rate_limited", { userId, ip, ua, detail: "/ads/promocao/iniciar" });
        return NextResponse.json({ error: "Muitas tentativas. Tente mais tarde" }, { status: 429, headers: NO_STORE });
      }
    } catch {
      return NextResponse.json({ error: "Serviço temporariamente indisponível" }, { status: 503, headers: NO_STORE });
    }

    let corpo: { desafioId?: unknown };
    try {
      corpo = await readJsonBody<{ desafioId?: unknown }>(req, LIMITE_DO_CORPO);
    } catch {
      return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
    }
    const desafioId =
      typeof corpo?.desafioId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(corpo.desafioId.trim())
        ? corpo.desafioId.trim()
        : null;
    if (!desafioId) {
      return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
    }

    let inicio;
    try {
      inicio = await iniciar({ desafioId, userId, dispositivo: usuario.deviceId, agora: agora() });
    } catch {
      return NextResponse.json({ error: "Serviço temporariamente indisponível" }, { status: 503, headers: NO_STORE });
    }

    if (inicio.situacao !== "iniciada") {
      // Inexistente, expirado, consumido, de outra conta ou de outro aparelho.
      // Uma resposta só, pelo mesmo motivo de `/ads/complete`.
      await registrarAbuso(ip);
      audit("play_token_rejected", { userId, ip, ua, detail: "/ads/promocao/iniciar: desafio inválido" });
      return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
    }

    if (!inicio.repetida) {
      audit("play_token_issued", {
        userId, ip, ua,
        detail: `promocao tv iniciada versao:${inicio.promocao.versao} host:${hostParaLog(inicio.promocao.videoUrl)}`,
      });
    }

    return NextResponse.json(
      {
        videoUrl: inicio.promocao.videoUrl,
        // Informativo, para a interface. O servidor não relê este número: o
        // tempo mínimo sai do desafio.
        duracaoSeg: Math.round(inicio.promocao.duracaoMs / 1000),
        versao: inicio.promocao.versao,
      },
      { headers: NO_STORE },
    );
  };
}

/** Next só aceita exports de método em route.ts; o teste usa a mesma fábrica. */
export const POST = Object.assign(createIniciarPromocaoHandler(), { createForTest: createIniciarPromocaoHandler });
