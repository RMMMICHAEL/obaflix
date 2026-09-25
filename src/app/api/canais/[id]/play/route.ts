export const dynamic = "force-dynamic";
export const maxDuration = 20;

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { clientIp, checkRateLimit, readJsonBody } from "@/lib/requestSecurity";
import { entitlementsDoUsuario, EntitlementsIndefinidos } from "@/lib/entitlements";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/auditLog";
import { autorizarPorAnuncio, type ResultadoDeAnuncio } from "@/lib/ads/enforcement";
import { autorizarCanal } from "@/lib/canais/acesso";
import {
  ehProviderConhecido,
  hostDeMidiaPermitido,
  type ProviderDeCanal,
} from "@/lib/canais/providers";
import { resolverCanal, FalhaNaResolucao, type FonteDeCanalResolvida } from "@/lib/canais/resolver";

/**
 * `POST /api/canais/[id]/play` — a concessão de reprodução.
 *
 * É o único ponto do sistema que decide se um canal pode tocar, e decide do
 * zero a cada chamada. O catálogo já não lista o que a conta não alcança, mas
 * isso é filtro de vitrine: quem chegar aqui com um id que descobriu de outro
 * jeito passa pela mesma checagem completa.
 *
 * ## O que esta rota entrega
 *
 * Resolve a fonte no servidor e devolve ao cliente **apenas a `streamUrl`
 * validada** — a URL de mídia que o aparelho busca **direto**, pelo próprio IP.
 * Isso porque medimos que o provider libera IP residencial e bloqueia egress de
 * datacenter (Vercel/Cloudflare): quem tem de buscar a mídia é o aparelho, não a
 * nossa infra. Não há mais proxy de mídia pelo Worker no caminho de canal, nem
 * URL assinada, nem sessão no Redis para o edge.
 *
 * O que **nunca** sai daqui: `providerChannelId`, host da página do player,
 * template do provider, Referer. A resolução dinâmica continua exclusivamente no
 * backend (`resolverCanal`), e a URL final não é persistida em lugar nenhum — o
 * catálogo e os bundles seguem sem upstream. Limitação consciente: a `streamUrl`
 * é observável na aba Network durante a reprodução, como qualquer URL que o
 * navegador busca direto. Escondê-la de novo exigiria a nossa infra no caminho —
 * exatamente o que o provider bloqueia.
 *
 * ## Re-resolução em erro, não renovação por relógio
 *
 * A URL do provider não vence num relógio nosso: vale até rotacionar/cair. Por
 * isso não há mais renovação periódica. Quando a reprodução falha, o cliente
 * volta aqui com `{ reresolucao: true }` e recebe uma URL nova — uma
 * reautorização de verdade (autentica, relê entitlement, reaplica rate limit),
 * sem cobrar anúncio de novo, porque é continuação da mesma exibição. O teto de
 * quantas re-resoluções o cliente dispara vive no cliente (ver `handoff.ts`).
 *
 * ## Ordem das checagens, e por que ela é essa
 *
 * Bloqueio de IP e rate limit vêm **antes** da autenticação porque são as
 * defesas contra quem ainda não provou ser ninguém. A resolução — a única parte
 * cara, que fala com o provider — vem **por último**, depois de a conta estar
 * autenticada e o direito confirmado. Inverter isso transformaria o endpoint
 * numa forma barata de fazer a Vercel buscar o provider em nome de qualquer um.
 *
 * ## Sobre trocar o `id` na mão
 *
 * O `id` da URL é usado só para **buscar** o canal. Tudo que decide acesso sai
 * da linha do banco (`nivelMinimo`, `ativo`, `adulto`) e do plano da conta.
 * Trocar o id busca outro canal e refaz a mesma checagem — nunca eleva acesso.
 *
 * ## Por que uma fábrica
 *
 * Mesmo motivo das rotas de cobrança: a regra desta rota é o que mais precisa
 * de teste no recurso inteiro, e testá-la com `NextRequest`, Postgres e Redis
 * de verdade deixaria de fora justamente os caminhos de negação, que são os que
 * importam. A rota exportada é a fábrica com as dependências reais.
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/** Igual para "não existe", "desativado", "adulto" e "seu plano não alcança". */
function negar(status: number, erro: string) {
  return NextResponse.json({ erro }, { status, headers: NO_STORE });
}

/** O canal, na forma mínima que esta rota precisa. */
export interface CanalDoBanco {
  id: string;
  slug: string;
  nome: string;
  nivelMinimo: string;
  ativo: boolean;
  adulto: boolean;
  fonte: { provider: string; providerChannelId: string } | null;
}

export interface DependenciasDePlay {
  env: Record<string, string | undefined>;
  clientIp: (req: NextRequest) => string;
  isIpBlocked: (ip: string) => Promise<boolean>;
  recordAbuseAttempt: (ip: string) => Promise<void>;
  getUserFromRequest: (req: NextRequest) => Promise<{ userId: string } | null>;
  checkRateLimit: (key: string, limit: number, janelaS: number) => Promise<{ allowed: boolean }>;
  lerCorpo: (req: NextRequest) => Promise<{ reresolucao?: unknown; concessao?: unknown }>;
  buscarCanal: (id: string) => Promise<CanalDoBanco | null>;
  nivelDaConta: (userId: string) => Promise<string>;
  resolver: (provider: ProviderDeCanal, providerChannelId: string) => Promise<FonteDeCanalResolvida>;
  autorizarAnuncio?: (e: {
    userId: string;
    tipo: "canal";
    concessao: string | null;
    alvo: { tipo: "canal"; conteudoId: string; temporada: null; episodio: null };
  }) => Promise<ResultadoDeAnuncio>;
  audit: typeof audit;
}

function createPlayCanalHandler(d: DependenciasDePlay) {
  return async function handler(
    req: NextRequest,
    ctx: { params: { id: string } | Promise<{ id: string }> },
  ): Promise<NextResponse> {
    const ip = d.clientIp(req);
    if (await d.isIpBlocked(ip)) return negar(429, "bloqueado");

    const usuario = await d.getUserFromRequest(req);
    if (!usuario) {
      // Contabiliza: uma sequência de tentativas sem sessão é varredura, e é o
      // sinal que alimenta o bloqueio por IP acima.
      await d.recordAbuseAttempt(ip);
      return negar(401, "nao_autenticado");
    }

    // Por conta, não por IP: um prédio inteiro atrás de um NAT não pode punir
    // uns aos outros. O limite acomoda a re-resolução em erro e ainda aperta
    // quem varre.
    const limite = await d.checkRateLimit(`canal:play:${usuario.userId}`, 20, 60);
    if (!limite.allowed) return negar(429, "muitas_tentativas");

    const { id } = await ctx.params;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      return negar(404, "canal_indisponivel");
    }

    const canal = await d.buscarCanal(id);
    // 404 para canal inexistente e para canal fora do catálogo, com o mesmo
    // corpo: distinguir os dois diria a quem varre quais ids existem.
    if (!canal) return negar(404, "canal_indisponivel");

    let nivel: string;
    try {
      nivel = await d.nivelDaConta(usuario.userId);
    } catch (e) {
      const indefinido = e instanceof EntitlementsIndefinidos;
      return negar(503, indefinido ? "indeterminado" : "falha");
    }

    // A checagem completa acontece tanto na abertura quanto em cada re-resolução.
    // É isso que faz "reautorização" querer dizer alguma coisa: um plano que caiu
    // no meio da tarde derruba a próxima re-resolução.
    const decisao = autorizarCanal(canal, nivel);
    if (decisao.situacao === "indeterminado") return negar(503, "indeterminado");
    if (decisao.situacao === "negado") {
      d.audit("canal_negado", {
        userId: usuario.userId,
        ip,
        detail: `canal ${canal.id} nivel ${nivel} < ${decisao.nivelExigido}`,
      });
      // Canal fora do ar e plano insuficiente chegam aqui iguais. A resposta
      // distingue só o que o produto precisa mostrar — a chamada de upgrade —,
      // e só quando o canal de fato está no catálogo.
      return canal.ativo && !canal.adulto
        ? NextResponse.json(
            { erro: "upgrade_necessario", nivelExigido: decisao.nivelExigido },
            { status: 403, headers: NO_STORE },
          )
        : negar(404, "canal_indisponivel");
    }

    const corpo: { reresolucao?: unknown; concessao?: unknown } = await d.lerCorpo(req).catch(() => ({}));
    // Continuação após erro de reprodução: não cobra anúncio de novo. A abertura
    // nova (sem a flag) passa pelo mesmo enforcement de filmes/episódios.
    const ehReresolucao = corpo.reresolucao === true;

    if (!ehReresolucao) {
      const anuncio = await (d.autorizarAnuncio ?? (async () => ({ liberado: true as const, via: "flag_desligada" as const })))({
        userId: usuario.userId,
        tipo: "canal",
        concessao: typeof corpo.concessao === "string" ? corpo.concessao : null,
        alvo: { tipo: "canal", conteudoId: canal.id, temporada: null, episodio: null },
      });
      if (!anuncio.liberado) return negar(anuncio.motivo === "indeterminado" ? 503 : 403, "anuncio_necessario");
    }

    if (!canal.fonte || !ehProviderConhecido(canal.fonte.provider)) {
      return negar(503, "canal_sem_fonte");
    }

    let fonte: FonteDeCanalResolvida;
    try {
      // A resolução usa sempre o id canônico do canal do banco, nunca o slug do
      // cliente, e é o único ponto que fala com o provider.
      fonte = await d.resolver(canal.fonte.provider, canal.fonte.providerChannelId);
    } catch (e) {
      const motivo = e instanceof FalhaNaResolucao ? e.motivo : "erro";
      // O motivo vai para o log, não para o corpo: "midia_nao_encontrada"
      // diria a quem varre que o canal existe e que o provider respondeu.
      d.audit("canal_resolucao_falhou", {
        userId: usuario.userId,
        ip,
        detail: `canal ${canal.id}: ${motivo}`,
      });
      return negar(503, "midia_indisponivel");
    }

    // Defesa em profundidade antes de a URL sair para o aparelho: só HTTPS e só
    // host na allowlist de mídia. `resolverCanal` já valida (assertSafeUrl +
    // allowlist), mas agora a URL vai para o cliente — reconferir aqui é barato e
    // fecha o caso de um resolver futuro afrouxar sem esta rota perceber.
    let hostDaMidia: string;
    try {
      const u = new URL(fonte.streamUrl);
      if (u.protocol !== "https:") throw new Error("nao https");
      hostDaMidia = u.hostname;
    } catch {
      d.audit("canal_resolucao_falhou", {
        userId: usuario.userId,
        ip,
        detail: `canal ${canal.id}: stream_invalida`,
      });
      return negar(503, "midia_indisponivel");
    }
    if (!hostDeMidiaPermitido(hostDaMidia, d.env)) {
      d.audit("canal_resolucao_falhou", {
        userId: usuario.userId,
        ip,
        detail: `canal ${canal.id}: stream_fora_allowlist`,
      });
      return negar(503, "midia_indisponivel");
    }

    return NextResponse.json(
      {
        canal: { id: canal.id, slug: canal.slug, nome: canal.nome },
        /**
         * A URL de mídia que o aparelho busca direto. Validada (https +
         * allowlist), transitória e nunca persistida. Em erro de reprodução o
         * cliente volta com `{ reresolucao: true }` e recebe outra.
         */
        streamUrl: fonte.streamUrl,
      },
      { headers: NO_STORE },
    );
  };
}

export const POST = Object.assign(createPlayCanalHandler({
  env: process.env,
  clientIp,
  isIpBlocked,
  recordAbuseAttempt,
  getUserFromRequest,
  checkRateLimit,
  // Corpo minúsculo e opcional: `{ reresolucao?, concessao? }`. 1 KB é folga de
  // sobra, e um corpo ausente é o caso normal da primeira chamada.
  lerCorpo: (req) => readJsonBody<{ reresolucao?: unknown; concessao?: unknown }>(req, 1024),
  buscarCanal: (id) =>
    prisma.canal.findFirst({
      // Aceita id ou slug: o cliente React navega por slug, o Kotlin guarda id.
      where: { OR: [{ id }, { slug: id }] },
      select: {
        id: true,
        slug: true,
        nome: true,
        nivelMinimo: true,
        ativo: true,
        adulto: true,
        fonte: { select: { provider: true, providerChannelId: true } },
      },
    }),
  nivelDaConta: async (userId) => (await entitlementsDoUsuario(userId)).direitos.canaisNivel,
  resolver: resolverCanal,
  autorizarAnuncio: (entrada) => autorizarPorAnuncio(entrada),
  audit,
}), { createForTest: createPlayCanalHandler });
