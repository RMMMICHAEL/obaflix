/**
 * O material assinado das URLs de canal — compartilhado entre backend e edge.
 *
 * Módulo **puro e sem dependência**, pelo mesmo motivo de `hls.ts`: ele é
 * compilado dentro do Cloudflare Worker e também importado pelo Node do Next.
 *
 * O HMAC em si não pode ser compartilhado (Node usa `crypto`, o Worker usa
 * WebCrypto, e um é síncrono e o outro não). Mas o HMAC não é a parte que
 * diverge em silêncio — a string assinada é. Se um lado assinar
 * `m:sid:n:master:123` e o outro conferir `m:sid:master:123`, nada falha no
 * build, nada falha no teste de cada lado isolado, e todo canal para em
 * produção. Por isso a string mora aqui, num lugar só.
 */

export type EscopoDeCanal = "m" | "s";

export interface RecursoAssinado {
  /** `"m"` manifesto (master ou variante), `"s"` segmento. */
  escopo: EscopoDeCanal;
  sessionId: string;
  /**
   * Nonce **da sessão**, e não da URL.
   *
   * É o que transforma a assinatura em algo revogável. O nonce nunca viaja na
   * URL: o edge o lê da sessão no Redis e recalcula o HMAC com ele. Consequência
   * — no instante em que a sessão é renovada (nonce rotacionado) ou apagada,
   * **toda** URL emitida antes para de conferir, mesmo dentro da validade.
   *
   * Sem isto, a assinatura só dependeria de `exp`, e uma URL capturada valeria
   * até o relógio virar, sem forma de cortar antes.
   */
  nonce: string;
  /** `"master"`, ou `"<índice da base>/<caminho+query percent-encoded>"`. */
  recurso: string;
  /** Expiração em segundos Unix. */
  exp: number;
}

export function materialAssinado(p: RecursoAssinado): string {
  return `${p.escopo}:${p.sessionId}:${p.nonce}:${p.recurso}:${p.exp}`;
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

// ── Recurso: caminho + query dentro de um único segmento ─────────────────────

/**
 * Empacota o que vem depois da base upstream num **único segmento de URL**.
 *
 * O problema que isto resolve: a URI de um segmento pode ter query string
 * (`seg.ts?token=…`). Se ela fosse colada crua no caminho da URL do edge, a
 * query do upstream se misturaria com a nossa (`?e=…&k=…`) e, do outro lado, o
 * `pathname` não conteria mais o que foi assinado — a assinatura não fecharia,
 * e a reconstrução do alvo perderia a query.
 *
 * `encodeURIComponent` resolve os dois de uma vez: `?`, `&`, `#` e `/` viram
 * escapes, então o valor atravessa como um segmento só e volta idêntico.
 *
 * O provider medido na Fase A não usa query em segmento. Isto está aqui porque
 * o próximo pode usar, e o modo de falha seria assinatura quebrando em
 * produção para um provider novo — não em teste.
 */
export function empacotarRecurso(indiceDaBase: number, caminhoComQuery: string): string {
  return `${indiceDaBase}/${encodeURIComponent(caminhoComQuery)}`;
}

export interface RecursoDesempacotado {
  indiceDaBase: number;
  caminhoComQuery: string;
}

/** Inverso de `empacotarRecurso`. `null` quando o formato não bate. */
export function desempacotarRecurso(recurso: string): RecursoDesempacotado | null {
  const barra = recurso.indexOf("/");
  if (barra <= 0) return null;
  const indiceDaBase = Number(recurso.slice(0, barra));
  if (!Number.isInteger(indiceDaBase) || indiceDaBase < 0) return null;
  let caminhoComQuery: string;
  try {
    caminhoComQuery = decodeURIComponent(recurso.slice(barra + 1));
  } catch {
    return null;
  }
  if (!caminhoComQuery) return null;
  // Um caminho que volte a abrir caminho (`..`, `/`) sairia da base e mudaria o
  // alvo. A base termina em `/` e o que se concatena tem de ser só o resto.
  if (caminhoComQuery.startsWith("/") || caminhoComQuery.split(/[?#]/)[0].includes("..")) {
    return null;
  }
  return { indiceDaBase, caminhoComQuery };
}

// ── Origem ───────────────────────────────────────────────────────────────────

/**
 * Compara origens de forma estrutural, nunca por prefixo de string.
 *
 * `url.startsWith(base)` aceita `https://media.obaflix.app.evil.example` quando
 * a base é `https://media.obaflix.app` — o sufixo hostil vem depois e o prefixo
 * casa. Comparar `URL.origin` não tem essa falha: origem é esquema + host +
 * porta, e `media.obaflix.app.evil.example` é outro host.
 */
export function mesmaOrigem(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
