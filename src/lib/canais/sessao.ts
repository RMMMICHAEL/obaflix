/**
 * Sessão de reprodução de canal: o que o cliente recebe, e o que ele nunca vê.
 *
 * ## As duas metades
 *
 * **Privada (Redis).** Tudo que serve para buscar a mídia — canal, upstream
 * resolvido, página que arma o grant, bases de segmento, dono da sessão. Nunca
 * sai numa resposta. Vive num id opaco e aleatório, com TTL curto.
 *
 * **Pública (URL assinada).** O id opaco, uma expiração e um HMAC. Não carrega
 * upstream, nem provider, nem host de CDN, nem userId — nada que se decifre.
 * Um cliente que leia a própria URL aprende que existe uma sessão, e só.
 *
 * ## Por que Redis, e não KV
 *
 * O estado aqui decide autorização. KV da Cloudflare é eventualmente
 * consistente: uma revogação levaria até um minuto para valer em todos os
 * pontos, e é exatamente nesse minuto que um replay funciona. O Redis do
 * projeto já é a autoridade de uso único e limite de streams em
 * `playTokens.ts`, e o Worker o alcança pela API REST do Upstash. Se algum dia
 * for preciso estado fortemente consistente *dentro* da Cloudflare, o caminho é
 * Durable Objects — não KV.
 *
 * ## Por que duas expirações diferentes
 *
 * O manifesto é buscado durante horas (é TV ao vivo); o segmento é buscado uma
 * vez. Dar a mesma validade aos dois obrigaria a escolher entre sessão que
 * morre no meio do jogo e link de segmento que vale a tarde inteira.
 *
 * Então: a URL do manifesto vale `TTL_MANIFESTO_S`, e cada resposta de
 * manifesto **cunha na hora** as URLs dos segmentos dela, com
 * `TTL_SEGMENTO_S`. Como o player rebusca o manifesto a cada poucos segundos
 * numa live, os links de segmento se renovam sozinhos e nenhum deles sobrevive
 * muito além do instante em que foi útil.
 */

import crypto from "crypto";
import { getRedis } from "../redis";
import { audit } from "../auditLog";
import {
  chaveDaSessao,
  materialAssinado,
  materialDaChave,
  semanaDaChave,
  TAMANHO_DA_ASSINATURA,
  type RecursoAssinado,
} from "./assinatura";
import type { FonteDeCanalResolvida } from "./resolver";

// ── Parâmetros ───────────────────────────────────────────────────────────────

/** Sessão no Redis. Renovada a cada manifesto servido (janela deslizante). */
export const TTL_SESSAO_S = 30 * 60;

/** Validade da URL de manifesto entregue ao cliente. */
export const TTL_MANIFESTO_S = 60 * 60;

/** Validade de cada URL de segmento cunhada dentro de um manifesto. */
export const TTL_SEGMENTO_S = 5 * 60;



// ── Chave e assinatura (o mesmo dos dois lados) ──────────────────────────────

function derivarChave(semanaN: number): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET não configurado");
  return crypto.createHash("sha256").update(materialDaChave(secret, semanaN)).digest();
}

function hmac(p: RecursoAssinado, semanaN: number): string {
  return crypto
    .createHmac("sha256", derivarChave(semanaN))
    .update(materialAssinado(p))
    .digest("base64url")
    .slice(0, TAMANHO_DA_ASSINATURA);
}

export function assinar(p: RecursoAssinado): string {
  return hmac(p, semanaDaChave(Date.now()));
}

function iguaisEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Confere contra a chave da semana corrente e a da anterior. Não existe aqui
 * atalho por `===`: comparar assinatura com igualdade de string vaza o prefixo
 * correto por tempo de resposta.
 */
export function assinaturaConfere(
  p: RecursoAssinado,
  sig: string,
  agoraMs: number = Date.now(),
): boolean {
  const w = semanaDaChave(agoraMs);
  for (const semanaN of [w, w - 1]) {
    if (iguaisEmTempoConstante(hmac(p, semanaN), sig)) return true;
  }
  return false;
}

// ── Estado privado da sessão ─────────────────────────────────────────────────

/**
 * O que vive no Redis. Nenhum campo daqui tem caminho para uma resposta HTTP.
 *
 * `sub` é derivado do `userId`, não o `userId`. O Worker precisa saber que duas
 * requisições são do mesmo dono sem nunca receber a identidade real.
 */
export interface SessaoDeCanal {
  canalId: string;
  /** Sub opaco do dono. Derivado por HMAC, não reversível. */
  sub: string;
  /** URL de mídia resolvida. O cliente nunca a recebe. */
  upstream: string;
  /** Página que arma o grant do provider. O edge busca antes da mídia. */
  paginaDoPlayer: string;
  referer: string | null;
  userAgent: string | null;
  /**
   * Bases de URL dos segmentos, na ordem em que foram descobertas. A URL
   * pública carrega só o índice e o nome do arquivo; o host fica aqui.
   */
  bases: string[];
  /** Nonce da concessão. Muda a cada grant novo, invalidando o anterior. */
  nonce: string;
  criadaEm: number;
  expiraEm: number;
}

export function derivarSub(userId: string): string {
  return crypto
    .createHmac("sha256", derivarChave(semanaDaChave(Date.now())))
    .update(`canal:sub:${userId}`)
    .digest("base64url")
    .slice(0, 16);
}

/**
 * Cria a sessão e devolve o que o cliente pode ver.
 *
 * O `sessionId` são 24 bytes de `randomBytes` — não deriva de userId, canalId
 * nem timestamp. Adivinhar um id não é um ataque viável, e ainda assim a
 * assinatura teria de bater.
 */
export async function criarSessaoDeCanal(entrada: {
  userId: string;
  canalId: string;
  fonte: FonteDeCanalResolvida;
}): Promise<{ sessionId: string; exp: number; sig: string }> {
  const { userId, canalId, fonte } = entrada;
  const sessionId = crypto.randomBytes(24).toString("base64url");
  const agora = Date.now();

  const sessao: SessaoDeCanal = {
    canalId,
    sub: derivarSub(userId),
    upstream: fonte.streamUrl,
    paginaDoPlayer: fonte.paginaDoPlayer,
    referer: fonte.referer,
    userAgent: fonte.userAgent,
    bases: [],
    nonce: crypto.randomBytes(8).toString("base64url"),
    criadaEm: agora,
    expiraEm: agora + TTL_SESSAO_S * 1000,
  };

  await getRedis().set(chaveDaSessao(sessionId), JSON.stringify(sessao), { ex: TTL_SESSAO_S });

  const exp = Math.floor(agora / 1000) + TTL_MANIFESTO_S;
  const sig = assinar({ escopo: "m", sessionId, recurso: "master", exp });

  audit("canal_sessao_criada", {
    userId,
    detail: `canal ${canalId}`,
  });

  return { sessionId, exp, sig };
}

export async function lerSessao(sessionId: string): Promise<SessaoDeCanal | null> {
  const bruto = await getRedis().get(chaveDaSessao(sessionId));
  if (!bruto) return null;
  try {
    const s = JSON.parse(bruto) as SessaoDeCanal;
    if (typeof s.upstream !== "string" || typeof s.sub !== "string") return null;
    if (s.expiraEm < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

/** Encerra a sessão. Usado no logout, na revogação e ao trocar de canal. */
export async function encerrarSessao(sessionId: string): Promise<void> {
  await getRedis().del(chaveDaSessao(sessionId));
}
