export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { checkRateLimit, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { monetizacaoAtiva } from "@/lib/playbackAuthorization";
import {
  TEMPO_MINIMO_DE_ANUNCIO_MS,
  TTL_CONCESSAO_PROMOCAO_TV_S,
  consumirDesafio,
  emitirConcessao,
  escopoDaTv,
  esquecerInicioDaPromocao,
  inicioDaPromocao,
  marcarPago,
  promocaoCumprida,
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
 * assistido.** Nenhum dos meios desta fase confirma isso fora de banda:
 *
 *  - **Electron / Direct Link** — o link abre no navegador do sistema. Não há
 *    callback nenhum; o navegador não fala com a gente.
 *  - **Android / Unity interstitial** — o SDK avisa o próprio aplicativo que o
 *    anúncio fechou. Quem nos conta é o cliente.
 *  - **Android TV / promoção interna** — o fim do vídeo é observado pelo player
 *    da TV. Quem nos conta, de novo, é o cliente.
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
 * Na TV, dois passos a mais, ambos do servidor:
 *
 *  5. **sequência** — a conclusão exige o início gravado por
 *     `/api/ads/promocao/iniciar`. Sem início, não há promoção a concluir;
 *  6. **duração da peça** — entre início e conclusão precisa passar a duração
 *     congelada no desafio, e só o aparelho que abriu o desafio conclui.
 *
 * Nada disso impede um cliente modificado de esperar o tempo sem exibir o vídeo
 * e chamar esta rota. Impede replay, forja de desafio, pular o vídeo, conclusão
 * antecipada, uso por outro aparelho e reaproveitamento — que é o teto honesto
 * sem uma prova de exibição fora do cliente.
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
  marcarPago?: typeof marcarPago;
  inicioDaPromocao?: typeof inicioDaPromocao;
  esquecerInicioDaPromocao?: typeof esquecerInicioDaPromocao;
  isIpBlocked?: typeof isIpBlocked;
  recordAbuseAttempt?: typeof recordAbuseAttempt;
  agora?: () => number;
}

function createAdsCompleteHandler(deps: DependenciasDeConclusao = {}) {
  const usuarioDaRequisicao = deps.getUserFromRequest ?? getUserFromRequest;
  const flagAtiva = deps.monetizacaoAtiva ?? monetizacaoAtiva;
  const limitar = deps.checkRateLimit ?? checkRateLimit;
  const consumir = deps.consumirDesafio ?? consumirDesafio;
  const emitir = deps.emitirConcessao ?? emitirConcessao;
  const marcarPagoDoAlvo = deps.marcarPago ?? marcarPago;
  const lerInicio = deps.inicioDaPromocao ?? inicioDaPromocao;
  const esquecerInicio = deps.esquecerInicioDaPromocao ?? esquecerInicioDaPromocao;
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
  const instante = agora();
  const decorrido = instante - desafio.criadoEm;
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

  // ── Android TV: sequência e duração da promoção ───────────────────────────
  //
  // O desafio já foi consumido: qualquer recusa daqui para baixo o queima, e a
  // TV precisa voltar a `/authorize`. É o que impede sondar a conclusão em
  // série até o tempo passar — e, para quem assistiu de verdade, não custa nada,
  // porque a conclusão legítima só é enviada no fim do vídeo.
  const ehPromocaoTv = desafio.plataforma === "android_tv";
  if (ehPromocaoTv) {
    // Só o aparelho que abriu. `consumirDesafio` já recusou desafio de TV sem
    // promoção ou sem aparelho, então os dois existem aqui.
    if (!desafio.promocao || !usuario.deviceId || desafio.dispositivo !== usuario.deviceId) {
      await registrarAbuso(ip);
      audit("play_token_rejected", { userId, ip, ua, detail: "/ads/complete: promocao de outro aparelho" });
      return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
    }

    let iniciadaEm: number | null;
    try {
      iniciadaEm = await lerInicio(desafioId);
    } catch {
      return NextResponse.json(
        { error: "Serviço temporariamente indisponível" },
        { status: 503, headers: NO_STORE },
      );
    }

    if (iniciadaEm === null) {
      audit("playback_negado", { userId, ip, ua, detail: "/ads/complete promocao sem inicio" });
      return NextResponse.json(
        { error: "Acesso negado", codigo: "promocao_nao_iniciada" },
        { status: 403, headers: NO_STORE },
      );
    }

    if (!promocaoCumprida(iniciadaEm, instante, desafio.promocao.duracaoMs)) {
      audit("playback_negado", {
        userId, ip, ua,
        detail: `/ads/complete promocao antecipada (${instante - iniciadaEm}ms de ${desafio.promocao.duracaoMs}ms)`,
      });
      return NextResponse.json(
        { error: "Acesso negado", codigo: "anuncio_nao_concluido" },
        { status: 403, headers: NO_STORE },
      );
    }
  }

  // Sempre "soft" nesta fase. Ver o cabeçalho: nenhum meio confirma
  // servidor→servidor, e a constante não é parametrizável pelo cliente de
  // propósito — um campo no corpo que elevasse o nível seria o próprio buraco.
  const verificacao: NivelDeVerificacao = "soft";

  // Finalidade e alvo vêm do DESAFIO, gravado pelo servidor quando decidiu cobrar
  // o anúncio — nunca do corpo desta requisição. Um anúncio visto para baixar não
  // vira concessão de reprodução, nem de outro conteúdo.
  //
  // Na TV a concessão vive o mesmo que um passe: ela é usada no mesmo instante,
  // para abrir o conteúdo que ficou esperando.
  const concessao = await emitir({
    userId,
    finalidade: desafio.finalidade,
    verificacao,
    alvo: desafio.alvo,
    ttlS: ehPromocaoTv ? TTL_CONCESSAO_PROMOCAO_TV_S : undefined,
  });

  // Reprodução paga fica paga para aquele alvo durante a janela da concessão:
  // reabrir o mesmo filme ou episódio (retry, sessão expirada, voltar ao 3º
  // episódio) recebe passe sem outro anúncio. Download e transmissão são
  // pontuais e não recebem marca. Falhar ao marcar custa, no pior caso, um
  // anúncio a mais — nunca acesso indevido — e por isso não derruba a resposta.
  //
  // Na TV é também o que cobre a resposta perdida: se a concessão não chegar ao
  // aparelho, a nova pergunta a `/authorize` encontra o alvo pago e recebe passe
  // — sem segunda promoção e sem segunda concessão deste desafio.
  if (desafio.finalidade === "reproducao" && desafio.alvo) {
    try {
      // A TV marca no escopo do aparelho: a promoção dela não dispensa o anúncio
      // do celular, e o anúncio do celular não dispensa a promoção dela.
      await marcarPagoDoAlvo({
        userId,
        finalidade: desafio.finalidade,
        alvo: desafio.alvo,
        escopo: ehPromocaoTv && desafio.dispositivo ? escopoDaTv(desafio.dispositivo) : undefined,
      });
    } catch {
      /* conveniência, não autorização */
    }
  }

  if (ehPromocaoTv) {
    try {
      await esquecerInicio(desafioId);
    } catch {
      /* o TTL apaga de qualquer forma */
    }
  }

  audit("play_token_issued", {
    userId, ip, ua,
    detail: `concessao de anuncio (${verificacao}) finalidade:${desafio.finalidade} plataforma:${desafio.plataforma} tipo:${desafio.tipo}`,
  });

  return NextResponse.json({ concessao }, { headers: NO_STORE });
  };
}

/** Next só aceita exports de método em route.ts; o teste usa a mesma fábrica. */
export const POST = Object.assign(createAdsCompleteHandler(), { createForTest: createAdsCompleteHandler });
