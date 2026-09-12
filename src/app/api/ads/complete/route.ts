export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { monetizacaoAtiva } from "@/lib/playbackAuthorization";
import {
  TEMPO_MINIMO_DE_ANUNCIO_MS,
  consumirDesafio,
  emitirConcessao,
  type NivelDeVerificacao,
} from "@/lib/ads/concessoes";

/**
 * `POST /api/ads/complete` — "o anúncio acabou, libere a reprodução".
 *
 * Consome o desafio e emite a concessão. É a única porta que emite concessão de
 * reprodução, e ela exige um desafio que o **servidor** abriu.
 *
 * ## O que esta rota sabe, e o que ela não sabe
 *
 * Ela sabe que abriu um desafio para esta conta há pouco tempo, e que alguém com
 * a sessão dessa conta voltou com o id. **Ela não sabe que o anúncio foi
 * assistido.** Nenhuma das duas redes desta fase confirma isso fora de banda:
 *
 *  - **Electron / Direct Link** — o link abre no navegador do sistema. Não há
 *    callback nenhum; o navegador não fala com a gente.
 *  - **Android / Unity interstitial** — o SDK avisa o próprio aplicativo que o
 *    anúncio fechou. Quem nos conta é o cliente.
 *
 * Por isso a concessão nasce marcada `verificacao: "soft"`, e é assim que ela
 * entra no log. **Não há verificação forte aqui, e fingir que há seria pior do
 * que não ter**: alguém confiaria numa garantia inexistente ao decidir quanto
 * conteúdo liberar. Ver `docs/monetizacao-arquitetura.md` para o que seria
 * preciso para chegar a `"hard"`.
 *
 * O que *é* real, e limita o abuso ao que o desenho aceita:
 *
 *  1. **desafio de uso único, emitido pelo servidor** — sem ele nada é emitido,
 *     e ele morre no primeiro uso;
 *  2. **tempo mínimo verificado no servidor** — o desafio guarda `criadoEm`, e
 *     uma conclusão que chega rápido demais para um anúncio ter acontecido é
 *     recusada. O relógio é nosso, não do cliente;
 *  3. **rate limit por conta** — pedir concessão em série custa 429;
 *  4. **concessão presa à conta e à finalidade**, de uso único e com TTL.
 *
 * Nada disso impede um cliente modificado de fechar o anúncio e chamar esta
 * rota. Impede replay, forja de desafio, automação rápida e reaproveitamento —
 * que é o teto honesto sem SSV.
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
const LIMITE_DO_CORPO = 1024;

/** Tentar liberar reprodução é barato; repetir em série não deve ser. */
const LIMITE_POR_CONTA = 20;
const JANELA_SEGUNDOS = 3600;

interface Corpo {
  desafioId?: unknown;
  /**
   * O que o cliente afirma sobre a conclusão.
   *
   * Entra no log e **não** decide nada: um `true` aqui não emite concessão
   * sozinho, porque o desafio e o tempo mínimo é que decidem. O campo existe
   * para distinguir "o usuário fechou o anúncio antes do fim" de "terminou",
   * quando o SDK sabe a diferença — informação de produto, não autorização.
   */
  concluido?: unknown;
}

/** As portas desta rota. Mesmo padrao de `createAuthorizeHandler`. */
export interface DependenciasDeConclusao {
  getUserFromRequest?: typeof getUserFromRequest;
  monetizacaoAtiva?: () => boolean;
  checkRateLimit?: typeof checkRateLimit;
  consumirDesafio?: typeof consumirDesafio;
  emitirConcessao?: typeof emitirConcessao;
  isIpBlocked?: typeof isIpBlocked;
  recordAbuseAttempt?: typeof recordAbuseAttempt;
  agora?: () => number;
}

export function createAdsCompleteHandler(deps: DependenciasDeConclusao = {}) {
  const usuarioDaRequisicao = deps.getUserFromRequest ?? getUserFromRequest;
  const flagAtiva = deps.monetizacaoAtiva ?? monetizacaoAtiva;
  const limitar = deps.checkRateLimit ?? checkRateLimit;
  const consumir = deps.consumirDesafio ?? consumirDesafio;
  const emitir = deps.emitirConcessao ?? emitirConcessao;
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
    audit("origin_rejected", { ip, ua, detail: "/ads/complete" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const usuario = await usuarioDaRequisicao(req);
  if (!usuario) {
    await registrarAbuso(ip);
    audit("auth_failure", { ip, ua, detail: "/ads/complete sem sessão" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  }
  const userId = usuario.userId;

  // Com o enforcement desligado ninguém deveria chegar aqui — `/authorize`
  // responde PERMITIDO sem abrir desafio. Recusar em vez de emitir concessão
  // fecha a porta de pré-fabricar concessões antes de a monetização ligar.
  if (!flagAtiva()) {
    return NextResponse.json({ error: "Indisponível" }, { status: 404, headers: NO_STORE });
  }

  try {
    const limite = await limitar(`ads:complete:${userId}`, LIMITE_POR_CONTA, JANELA_SEGUNDOS);
    if (!limite.allowed) {
      audit("rate_limited", { userId, ip, ua, detail: "/ads/complete" });
      return NextResponse.json(
        { error: "Muitas tentativas. Tente mais tarde" },
        { status: 429, headers: NO_STORE },
      );
    }
  } catch {
    // Redis obrigatório indisponível: sem limite não há como distinguir uso de
    // automação, e emitir concessão sem teto é o lado errado do erro.
    return NextResponse.json(
      { error: "Serviço temporariamente indisponível" },
      { status: 503, headers: NO_STORE },
    );
  }

  let corpo: Corpo;
  try {
    corpo = await readJsonBody<Corpo>(req, LIMITE_DO_CORPO);
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

  const desafio = await consumir(desafioId, userId);
  if (!desafio) {
    // Inexistente, expirado, já usado, ou de outra conta. Uma resposta só para
    // os quatro: distinguir daria a quem estiver sondando um oráculo sobre
    // desafios alheios.
    await registrarAbuso(ip);
    audit("play_token_rejected", { userId, ip, ua, detail: "/ads/complete: desafio inválido" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  // ── Tempo mínimo, medido pelo nosso relógio ───────────────────────────────
  //
  // O desafio guarda quando NÓS o abrimos. Um "terminei" que chega antes de um
  // anúncio caber no intervalo não é um anúncio assistido — é automação, ou um
  // cliente que pulou a etapa. O desafio já foi consumido acima, então a
  // tentativa custa: quem tentar de novo precisa de um desafio novo.
  const decorrido = agora() - desafio.criadoEm;
  if (decorrido < TEMPO_MINIMO_DE_ANUNCIO_MS) {
    audit("playback_negado", {
      userId, ip, ua,
      detail: `/ads/complete cedo demais (${decorrido}ms) plataforma:${desafio.plataforma}`,
    });
    return NextResponse.json(
      { error: "Acesso negado", codigo: "anuncio_nao_concluido" },
      { status: 403, headers: NO_STORE },
    );
  }

  // Sempre "soft" nesta fase. Ver o cabeçalho: nenhuma das duas redes confirma
  // servidor→servidor, e a constante não é parametrizável pelo cliente de
  // propósito — um campo no corpo que elevasse o nível seria o próprio buraco.
  const verificacao: NivelDeVerificacao = "soft";

  const concessao = await emitir({ userId, finalidade: "reproducao", verificacao });

  audit("play_token_issued", {
    userId, ip, ua,
    detail: `concessao de anuncio (${verificacao}) plataforma:${desafio.plataforma} tipo:${desafio.tipo}`,
  });

  return NextResponse.json({ concessao }, { headers: NO_STORE });
  };
}

export const POST = createAdsCompleteHandler();
