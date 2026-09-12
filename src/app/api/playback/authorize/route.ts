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
  ehPlataformaDeAnuncio,
  registrarEpisodioDistinto,
} from "@/lib/ads/concessoes";
import { decidirAnuncio, exigeAnuncio } from "@/lib/ads/politica";
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

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const ua = req.headers.get("user-agent") || "unknown";

  if (await isIpBlocked(ip)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
  }

  // Mutação por cookie: mesma checagem de origem de `/fontes`. Cliente nativo
  // com Bearer não manda `Origin` e não é afetado.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    await recordAbuseAttempt(ip);
    audit("origin_rejected", { ip, ua, detail: "/playback/authorize" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const usuario = await getUserFromRequest(req);
  if (!usuario) {
    await recordAbuseAttempt(ip);
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

  const plataforma = ehPlataformaDeAnuncio(corpo.plataforma) ? corpo.plataforma : null;

  // ── Flag desligada: permitido, sem consultar nada ──────────────────────────
  if (!monetizacaoAtiva()) {
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
    direitos = (await entitlementsDoUsuario(userId)).direitos;
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
      distintos = await registrarEpisodioDistinto({
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
    temConcessao = await concessaoValida(concessaoDica, userId);
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

  // ── Anúncio necessário ────────────────────────────────────────────────────
  if (!plataforma) {
    // Plataforma desconhecida não tem como exibir anúncio — Web pura, por
    // exemplo. Bloquear seria tirar acesso de quem não tem como pagar com
    // atenção; esta fase monetiza Android e Electron, e a Web fica como está.
    return NextResponse.json({ decisao: "PERMITIDO" }, { headers: NO_STORE });
  }

  const desafioId = await abrirDesafio({ userId, tipo: conteudoTipo, plataforma });

  const corpoResposta: Record<string, unknown> = {
    decisao: "ANUNCIO_NECESSARIO",
    desafioId,
  };

  if (plataforma === "electron") {
    const link = resolverDirectLink();
    if (link.situacao === "ok") {
      // Sai do servidor só aqui, e só para quem precisa ver anúncio no Electron.
      corpoResposta.directLink = link.url;
      audit("playback_negado", {
        userId, ip, ua,
        detail: `anuncio necessario electron host:${hostParaLog(link.url)}`,
      });
    } else {
      // Sem Direct Link configurado não há anúncio a exibir. Bloquear seria
      // punir o usuário por configuração nossa que falta — e a receita perdida
      // é nossa, não dele. Libera e registra.
      audit("playback_negado", {
        userId, ip, ua, detail: "direct link ausente — liberado sem anuncio",
      });
      return NextResponse.json({ decisao: "PERMITIDO" }, { headers: NO_STORE });
    }
  } else {
    audit("playback_negado", { userId, ip, ua, detail: "anuncio necessario android" });
  }

  return NextResponse.json(corpoResposta, { headers: NO_STORE });
}
