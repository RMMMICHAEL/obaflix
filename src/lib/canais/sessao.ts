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
 * upstream, nem provider, nem host de CDN, nem userId, nem o nonce — nada que
 * se decifre. Um cliente que leia a própria URL aprende que existe uma sessão,
 * e só.
 *
 * ## Segredo próprio, e não o `NEXTAUTH_SECRET`
 *
 * A chave sai de `CANAIS_MEDIA_SIGNING_SECRET`, que existe para isto e para
 * mais nada. O mesmo valor vive no backend e no Worker.
 *
 * Reaproveitar o `NEXTAUTH_SECRET` — como esta camada fazia antes — juntava dois
 * raios de impacto que não têm por que se tocar: o Worker roda em infra de
 * terceiro, com outra superfície de deploy e outra lista de quem pode ler
 * secrets, e um vazamento ali passaria a comprometer a assinatura de sessão de
 * autenticação do produto inteiro. Com chave própria, o pior caso de um
 * comprometimento do Worker é: emitir URL de mídia válida. Ruim, e limitado.
 *
 * Trocar a chave invalida toda concessão em voo e nada além disso — é rotação
 * barata, e é outra coisa que o acoplamento anterior tirava.
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
 * ## As três validades, e o que cada uma segura
 *
 * | | Quanto | Segura |
 * |---|---|---|
 * | `TTL_GRANT_S` | 5 min | URL de manifesto capturada morre rápido |
 * | `TTL_SEGMENTO_S` | 90 s | link de segmento não sobrevive ao instante em que foi útil |
 * | `VIDA_MAXIMA_DA_SESSAO_S` | 2 h | força re-resolução, e com ela o provider volta a ser consultado |
 *
 * O grant curto é o que obriga a **reautorização periódica pelo backend**: a
 * cada renovação, `/play` reconfere sessão, entitlement e rate limit, e rotaciona
 * o nonce. Rotacionar o nonce derruba na hora todas as URLs emitidas antes —
 * inclusive as que um capturador tivesse guardado dentro da validade.
 *
 * A renovação **não** re-resolve no provider: reaproveita o upstream da sessão.
 * Sem isso, um espectador de uma hora custaria doze buscas na página do player,
 * e a proteção sairia cara no lugar errado.
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

/** Validade da URL de manifesto entregue ao cliente. */
export const TTL_GRANT_S = 5 * 60;

/** Validade de cada URL de segmento cunhada dentro de um manifesto. */
export const TTL_SEGMENTO_S = 90;

/**
 * TTL da sessão no Redis. Um pouco maior que o grant, para a renovação ter
 * folga: o cliente pede a próxima antes de a atual vencer, e a sessão precisa
 * estar viva nesse instante.
 */
export const TTL_SESSAO_S = 7 * 60;

/**
 * Teto absoluto de uma sessão, independente de quantas renovações houve.
 *
 * Existe porque a janela deslizante sozinha é imortal: quem continua pedindo
 * continua tendo. Passando daqui, `/play` resolve de novo no provider — o que
 * também pega o caso de o provider ter trocado a mídia do canal.
 */
export const VIDA_MAXIMA_DA_SESSAO_S = 2 * 3600;

// ── Chave e assinatura (o mesmo dos dois lados) ──────────────────────────────

function derivarChave(semanaN: number): Buffer {
  const secret = process.env.CANAIS_MEDIA_SIGNING_SECRET;
  if (!secret) throw new Error("CANAIS_MEDIA_SIGNING_SECRET não configurado");
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
 */
export interface SessaoDeCanal {
  canalId: string;
  /**
   * Sub opaco do dono, derivado por HMAC — não é o `userId` e não é reversível.
   *
   * **Quem confere é o backend, na renovação**, onde a requisição vem
   * autenticada: é o que impede alguém renovar a sessão de outra conta com um
   * `sessionId` capturado.
   *
   * O edge **não** confere, e não teria como: a requisição do player não carrega
   * credencial nossa. Quem protege lá é a assinatura presa ao nonce. Está dito
   * aqui para o campo não ser lido como uma garantia que ele não dá.
   */
  sub: string;
  /** URL de mídia resolvida. O cliente nunca a recebe. */
  upstream: string;
  /** Página que arma o grant do provider. O edge busca antes da mídia. */
  paginaDoPlayer: string;
  referer: string | null;
  userAgent: string | null;
  /**
   * Bases de URL dos segmentos, na ordem em que foram descobertas. A URL
   * pública carrega só o índice e o caminho; o host fica aqui.
   */
  bases: string[];
  /**
   * Entra no material assinado, sem nunca viajar na URL. Rotaciona a cada
   * renovação, e rotacionar derruba toda URL emitida antes.
   */
  nonce: string;
  criadaEm: number;
  /** Fim da janela deslizante. */
  expiraEm: number;
  /** Teto absoluto. Não se move em renovação nenhuma. */
  expiraDefinitivamenteEm: number;
}

export function derivarSub(userId: string): string {
  return crypto
    .createHmac("sha256", derivarChave(semanaDaChave(Date.now())))
    .update(`canal:sub:${userId}`)
    .digest("base64url")
    .slice(0, 16);
}

export interface Concessao {
  sessionId: string;
  exp: number;
  sig: string;
  /** Segundos até a URL vencer. O cliente renova antes disso. */
  validoPorSegundos: number;
}

function assinarMaster(sessionId: string, nonce: string, agoraMs: number): Concessao {
  const exp = Math.floor(agoraMs / 1000) + TTL_GRANT_S;
  return {
    sessionId,
    exp,
    sig: assinar({ escopo: "m", sessionId, nonce, recurso: "master", exp }),
    validoPorSegundos: TTL_GRANT_S,
  };
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
}): Promise<Concessao> {
  const { userId, canalId, fonte } = entrada;
  const sessionId = crypto.randomBytes(24).toString("base64url");
  const agora = Date.now();
  const nonce = crypto.randomBytes(8).toString("base64url");

  const sessao: SessaoDeCanal = {
    canalId,
    sub: derivarSub(userId),
    upstream: fonte.streamUrl,
    paginaDoPlayer: fonte.paginaDoPlayer,
    referer: fonte.referer,
    userAgent: fonte.userAgent,
    bases: [],
    nonce,
    criadaEm: agora,
    expiraEm: agora + TTL_SESSAO_S * 1000,
    expiraDefinitivamenteEm: agora + VIDA_MAXIMA_DA_SESSAO_S * 1000,
  };

  await getRedis().set(chaveDaSessao(sessionId), JSON.stringify(sessao), { ex: TTL_SESSAO_S });

  audit("canal_sessao_criada", { userId, detail: `canal ${canalId}` });

  return assinarMaster(sessionId, nonce, agora);
}

/**
 * Renova uma concessão sem voltar ao provider.
 *
 * Devolve `null` — e quem chamou resolve do zero — quando a sessão sumiu, é de
 * outra conta, é de outro canal, ou passou do teto absoluto. Nenhum desses
 * casos é erro: são o caminho normal de volta para a resolução completa.
 *
 * O `sub` confere aqui, e só aqui, porque é o único ponto do fluxo em que se
 * sabe quem está pedindo.
 */
export async function renovarSessaoDeCanal(entrada: {
  userId: string;
  canalId: string;
  sessionId: string;
}): Promise<Concessao | null> {
  const { userId, canalId, sessionId } = entrada;
  const sessao = await lerSessao(sessionId);
  if (!sessao) return null;
  if (sessao.canalId !== canalId) return null;

  // Sem comparação em tempo constante de propósito: `sub` não é segredo, é
  // derivado de um id que o dono já conhece. O que ele impede é renovar a
  // sessão de outra conta com um `sessionId` capturado.
  if (sessao.sub !== derivarSub(userId)) return null;

  const agora = Date.now();
  if (agora >= sessao.expiraDefinitivamenteEm) return null;

  // Nonce novo: as URLs emitidas na concessão anterior param de conferir neste
  // instante, mesmo as que ainda estariam dentro do `exp`.
  const nonce = crypto.randomBytes(8).toString("base64url");
  const renovada: SessaoDeCanal = {
    ...sessao,
    nonce,
    expiraEm: agora + TTL_SESSAO_S * 1000,
  };

  await getRedis().set(chaveDaSessao(sessionId), JSON.stringify(renovada), { ex: TTL_SESSAO_S });

  return assinarMaster(sessionId, nonce, agora);
}

export async function lerSessao(sessionId: string): Promise<SessaoDeCanal | null> {
  const bruto = await getRedis().get(chaveDaSessao(sessionId));
  if (!bruto) return null;
  try {
    const s = JSON.parse(bruto) as SessaoDeCanal;
    if (typeof s.upstream !== "string" || typeof s.sub !== "string") return null;
    if (typeof s.nonce !== "string" || !s.nonce) return null;
    const agora = Date.now();
    if (s.expiraEm < agora) return null;
    if (typeof s.expiraDefinitivamenteEm !== "number" || s.expiraDefinitivamenteEm < agora) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** Encerra a sessão. Usado no logout, na revogação e ao trocar de canal. */
export async function encerrarSessao(sessionId: string): Promise<void> {
  await getRedis().del(chaveDaSessao(sessionId));
}
