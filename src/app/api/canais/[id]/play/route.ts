export const dynamic = "force-dynamic";
export const maxDuration = 20;

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { clientIp, checkRateLimit } from "@/lib/requestSecurity";
import { entitlementsDoUsuario, EntitlementsIndefinidos } from "@/lib/entitlements";
import { isIpBlocked, recordAbuseAttempt } from "@/lib/playTokens";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/auditLog";
import { autorizarCanal } from "@/lib/canais/acesso";
import { ehProviderConhecido, type ProviderDeCanal } from "@/lib/canais/providers";
import { resolverCanal, FalhaNaResolucao, type FonteDeCanalResolvida } from "@/lib/canais/resolver";
import { criarSessaoDeCanal, TTL_MANIFESTO_S } from "@/lib/canais/sessao";

/**
 * `POST /api/canais/[id]/play` — a concessão de reprodução.
 *
 * É o único ponto do sistema que decide se um canal pode tocar, e decide do
 * zero a cada chamada. O `liberado` que o catálogo devolveu é dica de
 * interface: um cliente adulterado que o force ganha um card sem cadeado e
 * chega aqui para receber 403.
 *
 * ## Ordem das checagens, e por que ela é essa
 *
 * Bloqueio de IP e rate limit vêm **antes** da autenticação porque são as
 * defesas contra quem ainda não provou ser ninguém. A resolução — a única parte
 * cara, que fala com o provider — vem **por último**, depois de a conta estar
 * autenticada e o direito confirmado. Inverter isso transformaria o endpoint
 * numa forma barata de fazer a Vercel buscar o provider em nome de qualquer um.
 *
 * ## A resposta
 *
 * O cliente recebe uma URL de manifesto no domínio de mídia do Obaflix e mais
 * nada. Sem upstream, sem provider, sem host de CDN, sem Referer. As três
 * plataformas consomem exatamente este contrato.
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
  buscarCanal: (id: string) => Promise<CanalDoBanco | null>;
  nivelDaConta: (userId: string) => Promise<string>;
  resolver: (provider: ProviderDeCanal, providerChannelId: string) => Promise<FonteDeCanalResolvida>;
  criarSessao: (e: {
    userId: string;
    canalId: string;
    fonte: FonteDeCanalResolvida;
  }) => Promise<{ sessionId: string; exp: number; sig: string }>;
  audit: typeof audit;
}

export function createPlayCanalHandler(d: DependenciasDePlay) {
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
    // uns aos outros. Resolver custa uma requisição ao provider, e 10/min é
    // folgado para quem assiste e apertado para quem varre.
    const limite = await d.checkRateLimit(`canal:play:${usuario.userId}`, 10, 60);
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

    if (!canal.fonte || !ehProviderConhecido(canal.fonte.provider)) {
      return negar(503, "canal_sem_fonte");
    }

    const baseDoEdge = d.env.CANAIS_MEDIA_BASE;
    if (!baseDoEdge) {
      // Sem edge configurado, a alternativa seria devolver o upstream ao
      // cliente. É exatamente o que não se faz: a URL deste provider é
      // permanente, e entregá-la uma vez é entregá-la para sempre.
      return negar(503, "midia_indisponivel");
    }

    let sessao: { sessionId: string; exp: number; sig: string };
    try {
      const fonte = await d.resolver(canal.fonte.provider, canal.fonte.providerChannelId);
      sessao = await d.criarSessao({ userId: usuario.userId, canalId: canal.id, fonte });
    } catch (e) {
      const motivo = e instanceof FalhaNaResolucao ? e.motivo : "erro";
      // O motivo vai para o log, não para o corpo: "midia_nao_encontrada" diria
      // a quem varre que o canal existe e que o provider respondeu.
      d.audit("canal_resolucao_falhou", {
        userId: usuario.userId,
        ip,
        detail: `canal ${canal.id}: ${motivo}`,
      });
      return negar(503, "midia_indisponivel");
    }

    return NextResponse.json(
      {
        canal: { id: canal.id, slug: canal.slug, nome: canal.nome },
        manifestUrl:
          `${baseDoEdge.replace(/\/+$/, "")}/canal/${sessao.sessionId}/master.m3u8` +
          `?e=${sessao.exp}&k=${sessao.sig}`,
        expiraEm: sessao.exp * 1000,
        /** Segundos até a URL acima deixar de valer. O cliente pede outra. */
        validoPorSegundos: TTL_MANIFESTO_S,
      },
      { headers: NO_STORE },
    );
  };
}

export const POST = createPlayCanalHandler({
  env: process.env,
  clientIp,
  isIpBlocked,
  recordAbuseAttempt,
  getUserFromRequest,
  checkRateLimit,
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
  criarSessao: criarSessaoDeCanal,
  audit,
});
