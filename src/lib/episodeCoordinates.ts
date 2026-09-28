/**
 * Coordenadas alternativas de episódio por provedor.
 *
 * O catálogo do Obaflix é a identidade canônica de um episódio (serieId,
 * temporada, numeroEp) — histórico, progresso, próximo episódio e URL pública
 * dependem dela e NADA aqui a altera. O que muda é só a coordenada enviada a
 * um provedor externo que divide as temporadas de outro jeito.
 *
 * Caso real que motivou isto (medido em 28/09/2026, tmdb 46298, Hunter x
 * Hunter 2011): o catálogo divide por arco (6 temporadas: 26/12/20/17/61/12),
 * enquanto WatchPlay e Playerflix seguem a divisão do TMDB (62/74/12). Pedir
 * `T2E1` ao WatchPlay devolve HTTP 200 e playlist viva — do absoluto 63, não do
 * 27. Ou seja: a coordenada canônica pode "funcionar" com o episódio ERRADO, e
 * nenhuma validação de mídia percebe. Por isso uma regra explícita pode pedir
 * para vir antes da canônica (`antesDoCanonico`).
 *
 * Este módulo é puro: nada de rede, banco ou Redis. Quem chama entrega a
 * estrutura do catálogo, as regras e a estratégia aprendida; aqui só sai a
 * lista ordenada, finita e sem repetição de tentativas.
 */

export type EstrategiaCoordenada = "canonical" | "continuous" | "alias";

export interface EpisodeCoordinate {
  season: number;
  episode: number;
  strategy: EstrategiaCoordenada;
}

/** Teto de tentativas por provedor, canônica incluída. Nunca cresce com dados. */
export const MAX_TENTATIVAS_COORDENADA = 4;

/**
 * Provedores cuja URL é montada por tmdbId + temporada + episódio. Os demais
 * (Hide, Wish, Voltz, RedeCanais, embeds do banco) chegam por episódio já
 * resolvido no catálogo e não têm coordenada para traduzir.
 */
export const PROVEDORES_COM_COORDENADA: ReadonlySet<string> = new Set([
  "webcine",
  "playerflix",
  "superflix",
  "watchplayer",
]);

// ── Regras explícitas por tmdbId + provedor ──────────────────────────────────

/**
 * Faixa → offset. `T{temporada}E{de}` vira `T{paraTemporada}E{paraEpisodio}`,
 * e cada episódio seguinte avança um: com de=1 e paraEpisodio=64, E2 → E65.
 */
export interface RegraFaixa {
  tipo: "faixa";
  tmdbId: string;
  provider: string;
  temporada: number;
  de: number;
  /** Inclusivo. Ausente: até o fim da temporada. */
  ate?: number;
  paraTemporada: number;
  paraEpisodio: number;
  antesDoCanonico?: boolean;
  /** Evidência que justificou a regra. Não é lida pelo código. */
  nota?: string;
}

/**
 * Divisão de temporadas do provedor, aplicada sobre o episódio absoluto do
 * catálogo. Uma regra cobre a série inteira, em vez de uma faixa por arco.
 * `numeracao: "relativa"` → S2E1, S2E2…; `"absoluta"` → S2E63, S2E64….
 * Sem estrutura segura do catálogo, a regra não produz nada.
 */
export interface RegraDivisao {
  tipo: "divisao";
  tmdbId: string;
  provider: string;
  /** Episódios por temporada no provedor, a partir da temporada 1. */
  temporadas: number[];
  numeracao: "relativa" | "absoluta";
  antesDoCanonico?: boolean;
  nota?: string;
}

export type RegraCoordenada = RegraFaixa | RegraDivisao;

// ── Estrutura do catálogo → episódio absoluto ────────────────────────────────

interface BlocoTemporada {
  /** Episódios desta temporada antes dela (soma das anteriores). */
  inicio: number;
  /** Quantos episódios distintos a temporada tem. */
  total: number;
  /** A temporada numera 1..total (relativa) e/ou inicio+1..inicio+total (absoluta). */
  relativa: boolean;
  absoluta: boolean;
}

function intervalo(de: number, ate: number): number[] {
  const saida: number[] = [];
  for (let i = de; i <= ate; i++) saida.push(i);
  return saida;
}

function mesmosNumeros(a: Set<number>, b: number[]): boolean {
  return a.size === b.length && b.every((n) => a.has(n));
}

/**
 * Lê a divisão do catálogo e decide se dá para confiar nela.
 *
 * Aceita, por temporada, só três formas — qualquer outra devolve null e a
 * estratégia contínua é omitida:
 *   - relativa contígua: 1..n
 *   - absoluta contígua: inicio+1..inicio+n
 *   - as duas ao mesmo tempo, com o MESMO n (o catálogo real do HxH tem cada
 *     episódio em duas linhas: T2E1 e T2E27 são o mesmo episódio 27)
 *
 * A forma dupla é, na verdade, a mais segura: a linha absoluta confirma a soma
 * das temporadas anteriores. Lacuna, bloco extra ou tamanho diferente é
 * catálogo incompleto — e aí somar daria episódio errado, não falha.
 *
 * Limite conhecido: com numeração só relativa, um fim de temporada que nunca
 * foi ingerido (1..20 de 26) não é detectável. A contínua só é tentada depois
 * da canônica falhar, o que reduz, mas não elimina, esse risco.
 */
export function estruturaDoCatalogo(
  linhas: ReadonlyArray<{ temporada: number; numeroEp: number }>,
  ateTemporada: number,
): Map<number, BlocoTemporada> | null {
  if (!Number.isInteger(ateTemporada) || ateTemporada < 1) return null;
  const porTemporada = new Map<number, Set<number>>();
  for (const l of linhas) {
    if (!Number.isInteger(l.temporada) || !Number.isInteger(l.numeroEp)) continue;
    if (l.temporada < 1 || l.temporada > ateTemporada || l.numeroEp < 1) continue;
    let s = porTemporada.get(l.temporada);
    if (!s) porTemporada.set(l.temporada, (s = new Set()));
    s.add(l.numeroEp);
  }

  const blocos = new Map<number, BlocoTemporada>();
  let inicio = 0;
  for (let t = 1; t <= ateTemporada; t++) {
    const eps = porTemporada.get(t);
    if (!eps || eps.size === 0) return null; // temporada faltando: soma impossível

    let bloco: BlocoTemporada | null = null;
    if (eps.has(1)) {
      let n = 0;
      while (eps.has(n + 1)) n++;
      if (eps.size === n) {
        bloco = { inicio, total: n, relativa: true, absoluta: t === 1 };
      } else if (inicio > 0 && eps.size === 2 * n && intervalo(inicio + 1, inicio + n).every((e) => eps.has(e))) {
        bloco = { inicio, total: n, relativa: true, absoluta: true };
      }
    } else if (inicio > 0) {
      const n = eps.size;
      if (mesmosNumeros(eps, intervalo(inicio + 1, inicio + n))) {
        bloco = { inicio, total: n, relativa: false, absoluta: true };
      }
    }
    if (!bloco) return null;
    blocos.set(t, bloco);
    inicio += bloco.total;
  }
  return blocos;
}

/**
 * Episódio absoluto de uma linha canônica. Distingue a linha relativa (T2E1)
 * da absoluta (T2E27) da mesma temporada; ambas dão 27. Null quando o número
 * não pertence a nenhum dos blocos que a estrutura reconheceu.
 */
export function episodioAbsoluto(
  estrutura: Map<number, BlocoTemporada> | null,
  temporada: number,
  episodio: number,
): number | null {
  const b = estrutura?.get(temporada);
  if (!b) return null;
  if (b.relativa && episodio >= 1 && episodio <= b.total) return b.inicio + episodio;
  if (b.absoluta && episodio > b.inicio && episodio <= b.inicio + b.total) return episodio;
  return null;
}

// ── Regras → coordenadas ─────────────────────────────────────────────────────

function aplicarRegra(
  regra: RegraCoordenada,
  temporada: number,
  episodio: number,
  absoluto: number | null,
): EpisodeCoordinate | null {
  if (regra.tipo === "faixa") {
    if (temporada !== regra.temporada || episodio < regra.de) return null;
    if (regra.ate !== undefined && episodio > regra.ate) return null;
    return { season: regra.paraTemporada, episode: regra.paraEpisodio + (episodio - regra.de), strategy: "alias" };
  }
  if (absoluto === null) return null;
  let antes = 0;
  for (let i = 0; i < regra.temporadas.length; i++) {
    const n = regra.temporadas[i];
    if (absoluto <= antes + n) {
      return {
        season: i + 1,
        episode: regra.numeracao === "relativa" ? absoluto - antes : absoluto,
        strategy: "alias",
      };
    }
    antes += n;
  }
  return null;
}

function valida(c: EpisodeCoordinate | null): c is EpisodeCoordinate {
  return !!c && Number.isInteger(c.season) && Number.isInteger(c.episode)
    && c.season >= 1 && c.episode >= 1 && c.season <= 1000 && c.episode <= 100000;
}

export interface EntradaCoordenadas {
  tmdbId: string;
  provider: string;
  season: number;
  episode: number;
  /** Resultado de `estruturaDoCatalogo`. Null: contínua e regras de divisão ficam de fora. */
  estrutura: Map<number, BlocoTemporada> | null;
  regras: ReadonlyArray<RegraCoordenada>;
  /** Estratégia que já resolveu este tmdbId neste provedor (Redis). Só reordena. */
  aprendida?: EstrategiaCoordenada | null;
}

/**
 * Lista ordenada e sem repetição do que tentar num provedor.
 *
 *   1. aprendida (se houver) — evita repetir a tentativa sabidamente inútil
 *   2. regras marcadas `antesDoCanonico` — canônica comprovadamente errada
 *   3. canônica — comportamento de sempre
 *   4. contínua — T1E{absoluto}, só com estrutura segura
 *   5. demais regras
 *
 * A canônica está sempre na lista: se a aprendida parar de funcionar, ela
 * continua sendo tentada. Duplicatas saem (T1E27 contínua == T1E27 regra), e a
 * lista nunca passa de MAX_TENTATIVAS_COORDENADA.
 */
export function resolveEpisodeCoordinates(e: EntradaCoordenadas): EpisodeCoordinate[] {
  const canonica: EpisodeCoordinate = { season: e.season, episode: e.episode, strategy: "canonical" };
  if (!PROVEDORES_COM_COORDENADA.has(e.provider)) return [canonica];

  const absoluto = episodioAbsoluto(e.estrutura, e.season, e.episode);
  const continua: EpisodeCoordinate | null = absoluto !== null
    ? { season: 1, episode: absoluto, strategy: "continuous" }
    : null;

  const regras = e.regras.filter((r) => r.tmdbId === e.tmdbId && r.provider === e.provider);
  const antes: EpisodeCoordinate[] = [];
  const depois: EpisodeCoordinate[] = [];
  for (const r of regras) {
    const c = aplicarRegra(r, e.season, e.episode, absoluto);
    if (c) (r.antesDoCanonico ? antes : depois).push(c);
  }

  const aprendida = e.aprendida === "canonical" ? canonica
    : e.aprendida === "continuous" ? continua
      : e.aprendida === "alias" ? (antes[0] ?? depois[0] ?? null)
        : null;

  const vistos = new Set<string>();
  const saida: EpisodeCoordinate[] = [];
  for (const c of [aprendida, ...antes, canonica, continua, ...depois]) {
    if (!valida(c)) continue;
    const chave = `${c.season}:${c.episode}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(c);
  }
  if (saida.length <= MAX_TENTATIVAS_COORDENADA) return saida;
  // O corte nunca leva a canônica: ela é a rede de segurança de qualquer regra.
  const cortada = saida.slice(0, MAX_TENTATIVAS_COORDENADA);
  if (!cortada.some((c) => c.strategy === "canonical")) {
    cortada[MAX_TENTATIVAS_COORDENADA - 1] = saida.find((c) => c.strategy === "canonical")!;
  }
  return cortada;
}

// ── Coordenada → URL do provedor ─────────────────────────────────────────────

/**
 * Reescreve a coordenada numa URL já montada por `montarFontes`. Cada formato
 * é o que o próprio `montarFontes` produz; qualquer outro devolve null e a
 * tentativa é descartada — nunca se inventa URL.
 */
export function urlComCoordenada(provider: string, embedUrl: string, c: EpisodeCoordinate): string | null {
  let u: URL;
  try { u = new URL(embedUrl); } catch { return null; }
  const s = String(c.season);
  const ep = String(c.episode);

  if (provider === "webcine" || provider === "playerflix") {
    if (!u.searchParams.has("season") || !u.searchParams.has("episode")) return null;
    u.searchParams.set("season", s);
    u.searchParams.set("episode", ep);
    return u.toString();
  }
  const partes = u.pathname.split("/").filter(Boolean);
  const prefixo = provider === "superflix" ? "serie" : provider === "watchplayer" ? "tvshow" : null;
  if (!prefixo || partes.length !== 4 || partes[0] !== prefixo) return null;
  u.pathname = `/${partes[0]}/${partes[1]}/${s}/${ep}`;
  return u.toString();
}

/** Forma curta para log: `T2E1`. Não carrega host, token nem URL. */
export const rotuloCoordenada = (c: { season: number; episode: number }) => `T${c.season}E${c.episode}`;
