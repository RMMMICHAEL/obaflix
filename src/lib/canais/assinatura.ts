/**
 * O material assinado das URLs de canal — compartilhado entre backend e edge.
 *
 * Módulo **puro e sem dependência**, pelo mesmo motivo de `hls.ts`: ele é
 * compilado dentro do Cloudflare Worker e também importado pelo Node do Next.
 *
 * O HMAC em si não pode ser compartilhado (Node usa `crypto`, o Worker usa
 * WebCrypto, e um é síncrono e o outro não). Mas o HMAC não é a parte que
 * diverge em silêncio — a string assinada é. Se um lado assinar
 * `m:sid:master:123` e o outro conferir `m:sid:master:123:`, nada falha no
 * build, nada falha no teste de cada lado isolado, e todo canal para em
 * produção. Por isso a string mora aqui, num lugar só.
 */

export type EscopoDeCanal = "m" | "s";

export interface RecursoAssinado {
  /** `"m"` manifesto (master ou variante), `"s"` segmento. */
  escopo: EscopoDeCanal;
  sessionId: string;
  /** `"master"`, ou `"<índice da base>/<caminho>"`. */
  recurso: string;
  /** Expiração em segundos Unix. */
  exp: number;
}

export function materialAssinado(p: RecursoAssinado): string {
  return `${p.escopo}:${p.sessionId}:${p.recurso}:${p.exp}`;
}

/**
 * Chave da semana. Rotação semanal com janela de transição, idêntica a
 * `playTokens.ts`: a chave corrente e a anterior valem, para uma sessão
 * iniciada perto da virada não morrer no meio.
 */
export function semanaDaChave(agoraMs: number): number {
  return Math.floor(agoraMs / (7 * 24 * 3600 * 1000));
}

export function materialDaChave(secret: string, semana: number): string {
  return `${secret}:week:${semana}`;
}

/** Comprimento do HMAC truncado nas URLs. 22 chars base64url ≈ 132 bits. */
export const TAMANHO_DA_ASSINATURA = 22;

/** Prefixo da chave de sessão no Redis. Os dois lados leem a mesma. */
export function chaveDaSessao(sessionId: string): string {
  return `canal:sessao:${sessionId}`;
}
