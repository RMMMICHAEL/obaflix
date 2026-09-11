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
   * Nonce **da geração**, e não da URL.
   *
   * É o que transforma a assinatura em algo revogável. O nonce nunca viaja na
   * URL: o edge o lê da sessão no Redis e recalcula o HMAC com ele.
   *
   * A sessão guarda dois: o corrente e o anterior, este último válido por uma
   * janela curta (`graceAte`). Sem essa janela, rotacionar o nonce mataria o
   * player em curso no mesmo instante — as URLs que ele já tinha parariam de
   * conferir antes de ele receber as novas. Com ela, as duas gerações convivem
   * o tempo do handoff e só isso. Ver `sessao.ts`.
   */
  nonce: string;
  /** `"master"`, ou `"<id da base>/<caminho+query percent-encoded>"`. */
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

// ── Identidade das bases ─────────────────────────────────────────────────────

/**
 * O material do id de uma base upstream.
 *
 * A base é a parte escondida de uma URL de mídia: esquema, host e diretório. O
 * id é `HMAC(chave, material)` truncado — **determinístico e opaco**.
 *
 * ## Por que não é mais um índice
 *
 * A versão anterior numerava as bases na ordem em que apareciam e guardava o
 * vetor dentro do documento da sessão. Dois manifestos filhos servidos ao mesmo
 * tempo liam o mesmo vetor, cada um acrescentava a sua base na posição
 * seguinte, e o `SET` do documento inteiro fazia last-write-wins: o índice 1 de
 * um manifesto podia acabar apontando para a base do outro. Índice errado é
 * pior do que índice ausente — o edge buscaria o host errado com assinatura
 * válida.
 *
 * Sendo derivado do conteúdo, o id não depende de ordem, não colide entre
 * descobertas concorrentes, e duas descobertas da mesma base gravam exatamente
 * o mesmo par chave/valor. A gravação vira idempotente e o pior caso deixa de
 * ser "aponta para outra base" e passa a ser "não encontrada" — que o edge
 * recusa e o player resolve rebuscando o manifesto.
 */
export function materialDoIdDaBase(base: string): string {
  return `canal:base:${base}`;
}

/** Comprimento do id de base na URL. 16 chars base64url ≈ 96 bits. */
export const TAMANHO_DO_ID_DE_BASE = 16;

/**
 * Chave Redis de uma base.
 *
 * **Não** é escopada por sessão de propósito: o mapa id→base é imutável (o id
 * deriva do valor), então compartilhá-lo entre sessões não confunde nada e
 * evita reescrever a mesma linha a cada reprodução. Quem autoriza é a
 * assinatura, que prende sessão e nonce — esta chave é só uma tabela de
 * consulta.
 */
export function chaveDaBase(idDaBase: string): string {
  return `canal:base:${idDaBase}`;
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
 * ## Isto é transporte, não sigilo
 *
 * `encodeURIComponent` é **reversível por qualquer um**: `seg.ts?token=abc`
 * vira `seg.ts%3Ftoken%3Dabc`, e decodificar é um clique. A query do upstream
 * **não é tratada como secreta neste desenho** — o que se esconde é o host,
 * pelo id opaco da base.
 *
 * Consequência para o futuro, e é regra: **um provider que traga credencial ou
 * token sensível na query do segmento não pode usar este caminho como está.**
 * Para ele, o valor precisa ficar no servidor e a URL carregar só um
 * identificador opaco — o mesmo padrão que `materialDoIdDaBase` já aplica ao
 * host. O provider medido na Fase A não põe nada na query, e é por isso que o
 * caminho reversível é aceitável hoje.
 */
export function empacotarRecurso(idDaBase: string, caminhoComQuery: string): string {
  return `${idDaBase}/${encodeURIComponent(caminhoComQuery)}`;
}

export interface RecursoDesempacotado {
  idDaBase: string;
  caminhoComQuery: string;
}

const ID_DE_BASE = /^[A-Za-z0-9_-]{8,32}$/;

/** Inverso de `empacotarRecurso`. `null` quando o formato não bate. */
export function desempacotarRecurso(recurso: string): RecursoDesempacotado | null {
  const barra = recurso.indexOf("/");
  if (barra <= 0) return null;
  const idDaBase = recurso.slice(0, barra);
  if (!ID_DE_BASE.test(idDaBase)) return null;

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
  return { idDaBase, caminhoComQuery };
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
