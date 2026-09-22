export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import { prisma } from "@/lib/prisma";
import { direitoDeCatalogo, monetizacaoAtiva, promocaoTvAtiva } from "@/lib/playbackAuthorization";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import {
  abrirDesafio,
  emitirPasse,
  escopoDaTv,
  estaPago,
  normalizarFinalidade,
  registrarEpisodioDistinto,
  type AlvoDeConcessao,
} from "@/lib/ads/concessoes";
import {
  decidirAnuncio,
  decidirPromocaoTv,
  exigeAnuncio,
  meioDeExibicao,
  plataformaDaRequisicao,
} from "@/lib/ads/politica";
import { hostParaLog, resolverDirectLink } from "@/lib/ads/directLink";
import { resolverPromocaoTv } from "@/lib/ads/promocaoTv";

/**
 * `POST /api/playback/authorize` — "posso reproduzir, baixar ou transmistir isto agora?"
 *
 * A porta do fluxo de anúncio, e o único lugar que decide. O cliente pergunta
 * antes da ação; o servidor responde uma decisão e, quando cabe, a prova que a
 * rota da ação vai consumir.
 *
 * **Esta rota não libera a mídia.** Ela responde uma decisão e emite a prova que
 * a rota da ação — `/api/player/fontes` — vai **consumir**: o desafio leva a uma
 * concessão depois do anúncio, e o caminho permitido para uma conta sujeita a
 * anúncio devolve um **passe de cota** junto do `PERMITIDO`. O enforcement
 * continua lá — nada disto entra no extractor nem no player.
 *
 * ## As decisões
 *
 * ```text
 * 200 PERMITIDO                 [+ passe]         reprodução liberada
 * 200 ANUNCIO_NECESSARIO        + desafioId       Android/Electron: anúncio externo
 * 200 PROMOCAO_TV_NECESSARIA    + desafioId       Android TV: promoção interna
 * 200 ANUNCIO_INDISPONIVEL      + codigo          sem meio de exibir: recusa
 * 200 NEGADO                    + codigo          Android TV: conteúdo fora do plano
 * 503 { codigo }                                  falha recuperável — tentar de novo
 * ```
 *
 * `PROMOCAO_TV_NECESSARIA` e `NEGADO` só saem para credencial de TV. Clientes
 * publicados (Android 1.0.17, Electron) nunca os recebem, e seguem com o
 * contrato de antes byte a byte.
 *
 * ## Por que PERMITIDO carrega passe
 *
 * Antes, o 1º e o 2º episódio do ciclo recebiam `PERMITIDO` sem nada, e
 * `/fontes` recusava toda conta sujeita a anúncio sem concessão. A política e o
 * enforcement discordavam: o episódio que pagou anúncio abria, e o seguinte
 * falhava com "não foi possível carregar os servidores". O passe é a prova
 * server-side, curta e de uso único, de que a política deixou passar — `/fontes`
 * não passa a confiar em nada vindo do cliente.
 *
 * ## Finalidades
 *
 *   - **reprodução** — segue a política: filme pede anúncio; série conta
 *     episódios distintos e o N-ésimo pede. Um alvo já pago na janela recebe
 *     passe, então retry, sessão expirada ou voltar ao 3º episódio não pedem um
 *     segundo anúncio e não somam no contador;
 *   - **download** e **transmissão** — liberação pontual: a conta sujeita a
 *     anúncio assiste um por ação. Não contam episódio e não recebem marca de pago.
 *     A TV não tem meio para elas: a promoção interna é só de reprodução.
 *
 * ## Android TV
 *
 * A plataforma sai da **credencial** (`plataformaDaRequisicao`), nunca do corpo.
 * A política é a mesma de todo mundo — mesmos direitos, mesma cadência de
 * episódios —, e só muda o meio: em vez de anúncio externo, o vídeo próprio do
 * Obaflix configurado em `PROMOCAO_TV_*`. Antes de abrir o desafio de promoção a
 * rota confere que o conteúdo existe: ninguém assiste a uma promoção para, no
 * fim, receber "conteúdo não encontrado".
 *
 * ## Quem nunca chega ao fluxo publicitário
 *
 * Conta com `anunciosObrigatorios !== true` sai antes de qualquer decisão, e a
 * resposta nem carrega campo de anúncio nem passe. Não é interface escondendo
 * botão: é ausência na resposta. Nenhuma decisão aqui olha nome ou id de plano.
 *
 * ## Com `MONETIZACAO_ATIVA` desligada
 *
 * Responde `PERMITIDO` **sem resolver entitlements** — mesmo bypass de
 * `autorizarCatalogo` e `limiteDeTelas`, e pelo mesmo motivo: enquanto o
 * enforcement não está ligado, esta camada não custa consulta nem cria modo de
 * falha novo no caminho de reprodução de todo mundo. Vale para a TV também.
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/** Corpo pequeno: dois identificadores, um tipo, a plataforma e a finalidade. */
const LIMITE_DO_CORPO = 1024;

interface Corpo {
  conteudoId?: unknown;
  conteudoTipo?: unknown;
  temporada?: unknown;
  numeroEp?: unknown;
  plataforma?: unknown;
  finalidade?: unknown;
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
 * O conteúdo pedido existe no catálogo?
 *
 * Uma consulta por chave, e só no caminho que vai abrir uma promoção na TV — o
 * caminho quente de assinante e o de celular não pagam por ela.
 */
async function conteudoExisteNoCatalogo(alvo: AlvoDeConcessao): Promise<boolean> {
  if (alvo.tipo === "filme") {
    const filme = await prisma.filme.findUnique({ where: { id: alvo.conteudoId }, select: { id: true } });
    return filme !== null;
  }
  if (alvo.temporada === null || alvo.episodio === null) return false;
  const episodio = await prisma.episodio.findFirst({
    where: { serieId: alvo.conteudoId, temporada: alvo.temporada, numeroEp: alvo.episodio },
    select: { id: true },
  });
  return episodio !== null;
}

/**
 * As portas desta rota. Injetaveis para o teste exercitar a sequencia inteira
 * sem Postgres, Redis, sessao nem rede — mesmo padrao de
 * `createGetPedidoHandler` e `createWebhookBlackcatHandler`.
 */
export interface DependenciasDeAutorizacao {
  getUserFromRequest?: typeof getUserFromRequest;
  monetizacaoAtiva?: () => boolean;
  promocaoTvAtiva?: () => boolean;
  entitlementsDoUsuario?: typeof entitlementsDoUsuario;
  registrarEpisodioDistinto?: typeof registrarEpisodioDistinto;
  emitirPasse?: typeof emitirPasse;
  estaPago?: typeof estaPago;
  abrirDesafio?: typeof abrirDesafio;
  resolverDirectLink?: typeof resolverDirectLink;
  resolverPromocaoTv?: typeof resolverPromocaoTv;
  conteudoExiste?: (alvo: AlvoDeConcessao) => Promise<boolean>;
  isIpBlocked?: typeof isIpBlocked;
  recordAbuseAttempt?: typeof recordAbuseAttempt;
}

function createAuthorizeHandler(deps: DependenciasDeAutorizacao = {}) {
  const usuarioDaRequisicao = deps.getUserFromRequest ?? getUserFromRequest;
  const flagAtiva = deps.monetizacaoAtiva ?? monetizacaoAtiva;
  const promoTvAtiva = deps.promocaoTvAtiva ?? promocaoTvAtiva;
  const resolverEntitlements = deps.entitlementsDoUsuario ?? entitlementsDoUsuario;
  const registrarEpisodio = deps.registrarEpisodioDistinto ?? registrarEpisodioDistinto;
  const criarPasse = deps.emitirPasse ?? emitirPasse;
  const jaPago = deps.estaPago ?? estaPago;
  const criarDesafio = deps.abrirDesafio ?? abrirDesafio;
  const lerDirectLink = deps.resolverDirectLink ?? resolverDirectLink;
  const lerPromocaoTv = deps.resolverPromocaoTv ?? resolverPromocaoTv;
  const conteudoExiste = deps.conteudoExiste ?? conteudoExisteNoCatalogo;
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

  const conteudoTipo = corpo.conteudoTipo === "serie"
    ? "serie"
    : corpo.conteudoTipo === "canal"
      ? "canal"
      : "filme";
  const conteudoId = identificador(corpo.conteudoId);
  if (!conteudoId) {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  // Ausente é reprodução; valor desconhecido é pedido inválido, e nunca vira
  // reprodução por engano.
  const finalidade = normalizarFinalidade(corpo.finalidade);
  if (!finalidade) {
    return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
  }

  // `android_tv` vem da credencial; do corpo, só `android` e `electron`.
  // Qualquer outra declaração vira `"web"` — a plataforma sem meio de exibição.
  // O desconhecido cai no caso mais restritivo.
  const plataforma = plataformaDaRequisicao(corpo.plataforma, usuario);

  // ── Flag desligada: permitido, sem consultar nada ──────────────────────────
  //
  // `PROMOCAO_TV_ATIVA` liga o enforcement APENAS para a Android TV (e só o
  // fluxo de promoção dela). A plataforma vem da credencial acima
  // (`plataformaDaRequisicao`), nunca do corpo — um cliente de cookie/celular
  // que declare `android_tv` já caiu em `web`, então não alcança este ramo.
  // Web, Android móvel e Electron seguem o bypass de sempre com global desligada.
  const enforcarPromocaoTv = promoTvAtiva() && plataforma === "android_tv";
  if (!flagAtiva() && !enforcarPromocaoTv) {
    return NextResponse.json({ decisao: "PERMITIDO" }, { headers: NO_STORE });
  }

  // ── Entitlements ──────────────────────────────────────────────────────────
  //
  // Fail-closed em cima do que dá para falhar com segurança: não conseguir
  // resolver direito não pode virar "assiste de graça sem anúncio" nem
  // "bloqueado". 503 é o mesmo tratamento que `/fontes` já dá — a ação não
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

  // ── TV: o conteúdo cabe no plano? ─────────────────────────────────────────
  //
  // `/fontes` recusaria de qualquer forma; dizer antes é o que deixa a TV
  // mostrar "Ver planos" em vez de um erro de servidor — e impede abrir uma
  // promoção para um conteúdo que o plano não alcança. Os direitos já estão
  // resolvidos: nenhuma consulta a mais.
  if (plataforma === "android_tv" && conteudoTipo !== "canal" && !direitoDeCatalogo(direitos, conteudoTipo)) {
    audit("playback_negado", { userId, ip, ua, detail: `authorize tv negado tipo:${conteudoTipo}` });
    return NextResponse.json(
      { decisao: "NEGADO", codigo: "conteudo_indisponivel_no_plano" },
      { headers: NO_STORE },
    );
  }

  // ── Quem não vê anúncio sai aqui, sem tocar em Redis de anúncio ───────────
  //
  // Sem passe: `/fontes` libera essas contas por direito, sem consumir nada.
  if (!exigeAnuncio(direitos)) {
    return NextResponse.json({ decisao: "PERMITIDO" }, { headers: NO_STORE });
  }

  // ── O alvo ────────────────────────────────────────────────────────────────
  //
  // Série sem temporada/episódio é pedido inválido em qualquer finalidade: é o
  // alvo que prende a concessão e o passe a um conteúdo só.
  let temporada: number | null = null;
  let numeroEp: number | null = null;
  if (conteudoTipo === "serie") {
    temporada = inteiroPositivo(corpo.temporada);
    numeroEp = inteiroPositivo(corpo.numeroEp);
    if (temporada === null || numeroEp === null) {
      return NextResponse.json({ error: "Parâmetros inválidos" }, { status: 400, headers: NO_STORE });
    }
  }
  const alvo: AlvoDeConcessao = { tipo: conteudoTipo, conteudoId, temporada, episodio: numeroEp };

  /**
   * PERMITIDO com passe. Falhar ao emitir é 503: sem passe, `/fontes` recusaria,
   * e responder PERMITIDO assim mesmo seria recriar a divergência que esta rota
   * existe para fechar.
   */
  const permitirComPasse = async (via: string) => {
    let passe: string;
    try {
      passe = await criarPasse({ userId, finalidade, alvo });
    } catch {
      audit("entitlements_indisponiveis", { userId, ip, ua, detail: "/authorize: passe" });
      return NextResponse.json(
        { error: "Serviço temporariamente indisponível", codigo: "entitlements_indisponiveis" },
        { status: 503, headers: NO_STORE },
      );
    }
    audit("playback_negado", {
      userId, ip, ua,
      detail: `authorize permitido (${via}) finalidade:${finalidade} tipo:${conteudoTipo}`,
    });
    return NextResponse.json({ decisao: "PERMITIDO", passe }, { headers: NO_STORE });
  };

  // ── Android TV: política própria ──────────────────────────────────────────
  //
  // Promoção antes de cada filme ou episódio novo (`decidirPromocaoTv`). Não
  // passa pelo contador de episódios nem pela marca de pago do celular: a TV
  // não consome a cota dele e não herda o que ele liberou. A única dispensa é a
  // recuperação no mesmo aparelho, com marca própria (`escopoDaTv`), para o
  // mesmo conteúdo.
  if (plataforma === "android_tv" && usuario.deviceId) {
    const escopo = escopoDaTv(usuario.deviceId);
    let liberadoNesteAparelho = false;
    if (finalidade === "reproducao") {
      try {
        liberadoNesteAparelho = await jaPago({ userId, finalidade, alvo, escopo });
      } catch {
        // Redis instável: pede a promoção. Custa um vídeo a mais, nunca acesso indevido.
        liberadoNesteAparelho = false;
      }
    }

    const decisaoTv = decidirPromocaoTv({ direitos, finalidade, liberadoNesteAparelho });
    if (decisaoTv.decisao === "permitido") return permitirComPasse(decisaoTv.via);

    // Download e transmissão não têm meio na TV; e promoção sem configuração
    // válida não é promoção. Os dois recusam, sem abrir desafio.
    const promocao = decisaoTv.decisao === "promocao_necessaria" ? lerPromocaoTv() : null;
    if (!promocao || promocao.situacao !== "ok") {
      const motivo = promocao?.situacao === "indisponivel" ? ` promocao:${promocao.motivo}` : "";
      audit("playback_negado", {
        userId, ip, ua,
        detail: `anuncio indisponivel plataforma:android_tv finalidade:${finalidade}${motivo}`,
      });
      return NextResponse.json(
        { decisao: "ANUNCIO_INDISPONIVEL", codigo: "anuncio_indisponivel" },
        { headers: NO_STORE },
      );
    }

    let existe: boolean;
    try {
      existe = await conteudoExiste(alvo);
    } catch {
      audit("entitlements_indisponiveis", { userId, ip, ua, detail: "/authorize: catalogo" });
      return NextResponse.json(
        { error: "Serviço temporariamente indisponível", codigo: "catalogo_indisponivel" },
        { status: 503, headers: NO_STORE },
      );
    }
    if (!existe) {
      return NextResponse.json({ error: "Conteúdo não encontrado" }, { status: 404, headers: NO_STORE });
    }

    // Promoção congelada no desafio, e o aparelho junto: só esta TV inicia e
    // conclui. Cada pedido abre o seu desafio — cancelar um não libera outro,
    // e dois pedidos paralelos pedem duas promoções.
    const desafioId = await criarDesafio({
      userId,
      tipo: conteudoTipo,
      plataforma: "android_tv",
      finalidade,
      alvo,
      promocao: promocao.promocao,
      dispositivo: usuario.deviceId,
    });

    audit("playback_negado", {
      userId, ip, ua,
      detail: `promocao tv necessaria tipo:${conteudoTipo} versao:${promocao.promocao.versao}`,
    });

    // O vídeo não vai aqui: sai em `/api/ads/promocao/iniciar`, que é onde a
    // sessão começa a contar. A TV só precisa do id para seguir.
    return NextResponse.json({ decisao: "PROMOCAO_TV_NECESSARIA", desafioId }, { headers: NO_STORE });
  }

  // ── Reprodução: política de anúncio (celular e Electron) ──────────────────
  //
  // Download e transmissão não entram aqui: são liberações pontuais, exigem
  // anúncio por ação e não contam episódio.
  if (finalidade === "reproducao") {
    // Alvo já pago nesta janela — retry, sessão expirada, voltar ao episódio que
    // pagou. Consultar antes de contar é o que evita um segundo anúncio para o
    // mesmo conteúdo. Redis instável cai no caminho normal: custa, no pior caso,
    // um anúncio a mais, nunca acesso indevido.
    let pago = false;
    try {
      pago = await jaPago({ userId, finalidade, alvo });
    } catch {
      pago = false;
    }
    if (pago) return permitirComPasse("ja_pago");

    // ── Contador de séries ──────────────────────────────────────────────────
    //
    // Registrado ANTES de decidir, porque registrar e contar são o mesmo passo:
    // é o `SET NX` de `registrarEpisodioDistinto` que faz reabrir o mesmo
    // episódio devolver o contador sem somar. Um contador lido antes e escrito
    // depois abriria a janela em que dois pedidos paralelos leem o mesmo valor.
    let distintos: number | undefined;
    if (conteudoTipo === "serie" && temporada !== null && numeroEp !== null) {
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

    const decisao = decidirAnuncio({
      direitos,
      tipo: conteudoTipo,
      temConcessao: false,
      episodiosDistintosNaJanela: distintos,
    });

    if (decisao.decisao === "permitido") return permitirComPasse(decisao.via);
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
  //
  // A TV não chega aqui: ela decidiu e respondeu no ramo próprio, acima.
  const link = plataforma === "electron" ? lerDirectLink() : null;
  const meio = meioDeExibicao(plataforma, link?.situacao === "ok");

  if (!meio) {
    // Nenhum desafio é aberto: não faz sentido emitir um desafio de uso único
    // que ninguém tem como cumprir, e cada desafio inútil é uma chave no Redis.
    audit("playback_negado", {
      userId, ip, ua,
      detail: `anuncio indisponivel plataforma:${plataforma} finalidade:${finalidade}`,
    });
    return NextResponse.json(
      {
        decisao: "ANUNCIO_INDISPONIVEL",
        codigo: "anuncio_indisponivel",
      },
      { headers: NO_STORE },
    );
  }

  // O desafio grava finalidade e alvo. `/api/ads/complete` os lê daqui, e não
  // do corpo dele: a concessão sai presa ao que o servidor decidiu cobrar.
  const desafioId = await criarDesafio({
    userId,
    tipo: conteudoTipo,
    // `meio` já provou que é uma das duas plataformas com anúncio externo.
    plataforma: plataforma === "android" ? "android" : "electron",
    finalidade,
    alvo,
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
      detail: `anuncio necessario electron finalidade:${finalidade} host:${hostParaLog(link.url)}`,
    });
  } else {
    audit("playback_negado", { userId, ip, ua, detail: `anuncio necessario android finalidade:${finalidade}` });
  }

  return NextResponse.json(corpoResposta, { headers: NO_STORE });
  };
}

/** Next só aceita exports de método em route.ts; o teste usa a mesma fábrica. */
export const POST = Object.assign(createAuthorizeHandler(), { createForTest: createAuthorizeHandler });
