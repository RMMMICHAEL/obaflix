export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { monetizacaoAtiva } from "@/lib/playbackAuthorization";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import {
  abrirDesafio,
  concessaoValida,
  normalizarPlataforma,
  registrarEpisodioDistinto,
} from "@/lib/ads/concessoes";
import { decidirAnuncio, exigeAnuncio, meioDeExibicao } from "@/lib/ads/politica";
import { hostParaLog, resolverDirectLink } from "@/lib/ads/directLink";

/**
 * `POST /api/playback/authorize` — "posso reproduzir isto agora?"
 *
 * A porta do fluxo de anúncio, e o único lugar que decide. O cliente pergunta
 * antes de abrir o player; o servidor responde `PERMITIDO` ou
 * `ANUNCIO_NECESSARIO` com um desafio.
 *
 * **Esta rota não libera reprodução.** Ela responde uma decisão e, no caminho
 * permitido, emite a concessão que `/api/player/fontes` vai **consumir**. Quem
 * abre sessão continua sendo aquela rota, e o enforcement continua lá — nada
 * disto entra no extractor nem no player.
 *
 * ## Quem nunca chega ao fluxo publicitário
 *
 * Conta com `anunciosObrigatorios !== true` sai em `decidirAnuncio` no primeiro
 * `if`, e a resposta nem carrega campo de anúncio. Não é interface escondendo
 * botão: é ausência na resposta. Nenhuma decisão aqui olha nome ou id de plano.
 *
 * ## Com `MONETIZACAO_ATIVA` desligada
 *
 * Responde `PERMITIDO` **sem resolver entitlements** — mesmo bypass de
 * `autorizarCatalogo` e `limiteDeTelas`, e pelo mesmo motivo: enquanto o
 * enforcement não está ligado, esta camada não custa consulta nem cria modo de
 * falha novo no caminho de reprodução de todo mundo.
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/** Corpo pequeno: dois identificadores, um tipo e a plataforma. */
const LIMITE_DO_CORPO = 1024;

interface Corpo {
  conteudoId?: unknown;
  conteudoTipo?: unknown;
  temporada?: unknown;
  numeroEp?: unknown;
  plataforma?: unknown;
  /** Concessão que o cliente já tem, se tiver. Não é prova — é uma dica. */
  concessao?: unknown;
}

function identificador(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const limpo = v.trim();
  return /^[A-Za-z0-9_:-]{1,64}$/.test(limpo) ? limpo : null;
}

function inteiroPositivo(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 100000 ? n : null;
}

/**
 * As portas desta rota. Injetaveis para o teste exercitar a sequencia inteira
 * sem Postgres, Redis, sessao nem rede — mesmo padrao de
 * `createGetPedidoHandler` e `createWebhookBlackcatHandler`.
 */
export interface DependenciasDeAutorizacao {
  getUserFromRequest?: typeof getUserFromRequest;
  monetizacaoAtiva?: () => boolean;
  entitlementsDoUsuario?: typeof entitlementsDoUsuario;
  registrarEpisodioDistinto?: typeof registrarEpisodioDistinto;
  concessaoValida?: typeof concessaoValida;
  abrirDesafio?: typeof abrirDesafio;
  resolverDirectLink?: typeof resolverDirectLink;
  isIpBlocked?: typeof isIpBlocked;
  recordAbuseAttempt?: typeof recordAbuseAttempt;
}

export function createAuthorizeHandler(deps: DependenciasDeAutorizacao = {}) {
  const usuarioDaRequisicao = deps.getUserFromRequest ?? getUserFromRequest;
  const flagAtiva = deps.monetizacaoAtiva ?? monetizacaoAtiva;
  const resolverEntitlements = deps.entitlementsDoUsuario ?? entitlementsDoUsuario;
  const registrarEpisodio = deps.registrarEpisodioDistinto ?? registrarEpisodioDistinto;
  const verificarConcessao = deps.concessaoValida ?? concessaoValida;
  const criarDesafio = deps.abrirDesafio ?? abrirDesafio;
  const lerDirectLink = deps.resolverDirectLink ?? resolverDirectLink;
  const ipBloqueado = deps.isIpBlocked ?? isIpBlocked;
  const registrarAbuso = deps.recordAbuseAttempt ?? recordAbuseAttempt;

  return async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const ua = req.headers.get("user-agent") || "unknown";

  if (await ipBloqueado(ip)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
  }

  // Mutação por cookie: mesma checagem de origem de `/fontes`. Cliente nativo
  // com Bearer não manda `Origin` e não é afetado.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    await registrarAbuso(ip);
    audit("origin_rejected", { ip, ua, detail: "/playback/authorize" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const usuario = await usuarioDaRequisicao(req);
  if (!usuario) {
    await registrarAbuso(ip);
    audit("auth_failure", { ip, ua, detail: "/playback/authorize sem sessão" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  }
  const userId = usuario.userId;

  let corpo: Corpo;
  try {
    corpo = await readJsonBody<Corpo>(req, LIMITE_DO_CORPO);
  } catch {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  const conteudoTipo = corpo.conteudoTipo === "serie" ? "serie" : "filme";
  const conteudoId = identificador(corpo.conteudoId);
  if (!conteudoId) {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  // Qualquer coisa que não seja `android` ou `electron` vira `"web"` — a
  // plataforma sem meio de exibição. O desconhecido cai no caso mais restritivo.
  const plataforma = normalizarPlataforma(corpo.plataforma);

  // ── Flag desligada: permitido, sem consultar nada ──────────────────────────
  if (!flagAtiva()) {
    return NextResponse.json({ decisao: "PERMITIDO" }, { headers: NO_STORE });
  }

  // ── Entitlements ──────────────────────────────────────────────────────────
  //
  // Fail-closed em cima do que dá para falhar com segurança: não conseguir
  // resolver direito não pode virar "assiste de graça sem anúncio" nem
  // "bloqueado". 503 é o mesmo tratamento que `/fontes` já dá — a reprodução não
  // começa, e o usuário recebe indisponibilidade temporária em vez de uma
  // decisão comercial tomada no escuro.
  let direitos;
  try {
    direitos = (await resolverEntitlements(userId)).direitos;
  } catch {
    audit("entitlements_indisponiveis", { userId, ip, ua, detail: "/playback/authorize" });
    return NextResponse.json(
      { error: "Serviço temporariamente indisponível", codigo: "entitlements_indisponiveis" },
      { status: 503, headers: NO_STORE },
    );
  }

  // ── Quem não vê anúncio sai aqui, sem tocar em Redis de anúncio ───────────
  if (!exigeAnuncio(direitos)) {
    return NextResponse.json({ decisao: "PERMITIDO" }, { headers: NO_STORE });
  }

  // ── Contador de séries ────────────────────────────────────────────────────
  //
  // Registrado ANTES de decidir, porque registrar e contar são o mesmo passo: é
  // o `SET NX` de `registrarEpisodioDistinto` que faz reabrir o mesmo episódio
  // devolver o contador sem somar. Um contador lido antes e escrito depois
  // abriria a janela em que dois pedidos paralelos leem o mesmo valor.
  let distintos: number | undefined;
  if (conteudoTipo === "serie") {
    const temporada = inteiroPositivo(corpo.temporada);
    const numeroEp = inteiroPositivo(corpo.numeroEp);
    if (temporada === null || numeroEp === null) {
      return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
    }
    try {
      distintos = await registrarEpisodio({
        userId, conteudoId, temporada, episodio: numeroEp, direitos,
      });
    } catch {
      audit("entitlements_indisponiveis", { userId, ip, ua, detail: "/authorize: contador" });
      return NextResponse.json(
        { error: "Serviço temporariamente indisponível", codigo: "entitlements_indisponiveis" },
        { status: 503, headers: NO_STORE },
      );
    }
  }

  // Concessão que o cliente já tenha em mãos. `concessaoValida` não consome —
  // quem consome é `/fontes`. Aqui ela só evita pedir um anúncio a quem acabou
  // de ver um.
  const concessaoDica = identificador(corpo.concessao);
  let temConcessao = false;
  try {
    temConcessao = await verificarConcessao(concessaoDica, userId);
  } catch {
    // Redis instável não deve travar a decisão: sem concessão confirmada, o
    // caminho é pedir anúncio. Custa um anúncio a mais, nunca acesso indevido.
    temConcessao = false;
  }

  const decisao = decidirAnuncio({
    direitos,
    tipo: conteudoTipo,
    temConcessao,
    episodiosDistintosNaJanela: distintos,
  });

  if (decisao.decisao === "permitido") {
    audit("playback_negado", {
      userId, ip, ua,
      detail: `authorize permitido (${decisao.via}) tipo:${conteudoTipo}`,
    });
    return NextResponse.json({ decisao: "PERMITIDO" }, { headers: NO_STORE });
  }

  // ── Anúncio necessário: existe meio de exibi-lo? ──────────────────────────
  //
  // A plataforma decide **como** o anúncio aparece, nunca **se** ele é exigido.
  // Sem meio de exibição não há anúncio a mostrar — e a resposta é recusa, não
  // liberação.
  //
  // A versão anterior devolvia PERMITIDO aqui, nos dois casos (plataforma sem
  // meio e Direct Link ausente), e isso era **fail-open inconsistente**: o
  // cliente recebia PERMITIDO, chamava `/api/player/fontes` sem concessão, e
  // era recusado lá — a autoridade final. O usuário via um erro genérico de
  // "não foi possível carregar os servidores" por uma configuração nossa que
  // faltava. Agora os dois lados dizem a mesma coisa.
  const link = plataforma === "electron" ? lerDirectLink() : null;
  const meio = meioDeExibicao(plataforma, link?.situacao === "ok");

  if (!meio) {
    // Nenhum desafio é aberto: não faz sentido emitir um desafio de uso único
    // que ninguém tem como cumprir, e cada desafio inútil é uma chave no Redis.
    audit("playback_negado", {
      userId, ip, ua,
      detail: `anuncio indisponivel plataforma:${plataforma}`,
    });
    return NextResponse.json(
      {
        decisao: "ANUNCIO_INDISPONIVEL",
        codigo: "anuncio_indisponivel",
      },
      { headers: NO_STORE },
    );
  }

  const desafioId = await criarDesafio({
    userId,
    tipo: conteudoTipo,
    // `meio` já provou que é uma das duas plataformas com exibição.
    plataforma: plataforma === "android" ? "android" : "electron",
  });

  const corpoResposta: Record<string, unknown> = {
    decisao: "ANUNCIO_NECESSARIO",
    desafioId,
  };

  if (meio === "direct_link" && link?.situacao === "ok") {
    // Sai do servidor só aqui: Electron, com anúncio necessário e link válido.
    // Assinante não recebe o campo — não é interface escondendo, é ausência.
    corpoResposta.directLink = link.url;
    audit("playback_negado", {
      userId, ip, ua,
      detail: `anuncio necessario electron host:${hostParaLog(link.url)}`,
    });
  } else {
    audit("playback_negado", { userId, ip, ua, detail: "anuncio necessario android" });
  }

  return NextResponse.json(corpoResposta, { headers: NO_STORE });
  };
}

export const POST = createAuthorizeHandler();
