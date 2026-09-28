/**
 * Adaptador da fonte de dados de "populares" — isolado de propósito.
 *
 * Hoje implementado com o TMDB (API oficial, sem restrição de scraping). Se um
 * dia precisar trocar de fonte (outra API, dataset licenciado, etc.), só essa
 * implementação muda — o cron (`src/app/api/cron/popular-sync/route.ts`) e o
 * resto do sistema dependem só da interface `PopularSource`.
 *
 * Não reaproveita `tmdbFetch` de `src/lib/tmdb.ts` de propósito: aquele helper
 * não tem timeout nem retry (foi pensado pra renderização de página, não pra
 * job em lote que precisa ser resiliente a uma chamada lenta/instável).
 */

const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";
const PAGE_SIZE = 20;
const RETRIES = 2;
const RETRY_DELAY_MS = 600;

export interface PopularItem {
  tmdbId: string;
  rank: number;
  // Metadados incluídos na resposta da API popular — usados para criar stubs
  titulo?: string;
  tituloOriginal?: string;
  poster?: string;
  backdrop?: string;
  ano?: number;
  nota?: number;
  voteCount?: number;
  popularidade?: number;
}

export interface PopularFetchStats {
  /** Itens brutos lidos de todas as páginas, antes da deduplicação. */
  raw: number;
  /** Ocorrências repetidas de um tmdbId já visto (drift de paginação). */
  duplicates: number;
  /** Itens sem o campo de título do tipo pedido (filme sem `title`, série sem `name`). */
  typeMismatches: number;
  pages: number;
}

export interface PopularFetchResult {
  /** Únicos por tmdbId, na ordem da primeira ocorrência; `rank` = posição entre os únicos. */
  items: PopularItem[];
  bytesTransferred: number;
  stats: PopularFetchStats;
}

export interface PopularSource {
  getPopularMovies(limit: number): Promise<PopularFetchResult>;
  getPopularSeries(limit: number): Promise<PopularFetchResult>;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TmdbResult {
  id: number;
  title?: string;          // filmes
  name?: string;           // séries
  original_title?: string;
  original_name?: string;
  poster_path?: string;
  backdrop_path?: string;
  release_date?: string;   // filmes
  first_air_date?: string; // séries
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
}

async function fetchPageWithRetry(path: string, page: number): Promise<{ results: TmdbResult[]; bytes: number } | null> {
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${BASE}${path}?api_key=${TMDB_KEY}&page=${page}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const data = JSON.parse(text);
      return { results: data.results ?? [], bytes: text.length };
    } catch {
      if (attempt <= RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function parseYear(dateStr?: string): number | undefined {
  if (!dateStr) return undefined;
  const y = parseInt(dateStr.slice(0, 4));
  return isNaN(y) ? undefined : y;
}

export type PopularPageFetcher = (path: string, page: number) => Promise<{ results: TmdbResult[]; bytes: number } | null>;

/**
 * Páginas extras além de `limit / 20`. O TMDB serve cada página do `/popular`
 * por CDN com idade própria (medido em 28/09/2026: `age` de 3s a ~72min entre
 * páginas da mesma leitura), então cada página é uma foto do ranking num
 * instante diferente: títulos perto da borda aparecem em duas páginas e
 * outros somem. A repetição é determinística (a mesma em leituras sequenciais,
 * paralelas e repetidas) e ficou em ~15% no Top 500. Ler 50% a mais de páginas
 * repõe os únicos perdidos sem mudar a ordem relativa.
 */
const OVERFETCH_RATIO = 1.5;

export async function collectPopular(
  path: string,
  limit: number,
  isSeries: boolean,
  fetchPage: PopularPageFetcher = fetchPageWithRetry,
): Promise<PopularFetchResult> {
  const maxPages = Math.ceil((limit / PAGE_SIZE) * OVERFETCH_RATIO);
  const items: PopularItem[] = [];
  const seen = new Set<string>();
  const stats: PopularFetchStats = { raw: 0, duplicates: 0, typeMismatches: 0, pages: 0 };
  let bytesTransferred = 0;

  for (let page = 1; page <= maxPages && items.length < limit; page++) {
    const result = await fetchPage(path, page);
    if (!result) break;
    stats.pages++;
    bytesTransferred += result.bytes;
    for (const r of result.results) {
      stats.raw++;
      const expectedTitle = isSeries ? r.name : r.title;
      if (!expectedTitle) stats.typeMismatches++;
      const tmdbId = String(r.id);
      if (seen.has(tmdbId)) { stats.duplicates++; continue; }
      seen.add(tmdbId);
      if (items.length >= limit) continue;
      items.push({
        tmdbId,
        rank: items.length + 1,
        titulo: expectedTitle ?? undefined,
        tituloOriginal: (isSeries ? r.original_name : r.original_title) ?? undefined,
        poster: r.poster_path ?? undefined,
        backdrop: r.backdrop_path ?? undefined,
        ano: parseYear(isSeries ? r.first_air_date : r.release_date),
        nota: r.vote_average ?? undefined,
        voteCount: r.vote_count ?? undefined,
        popularidade: r.popularity ?? undefined,
      });
    }
    if (result.results.length === 0) break;
  }
  return { items, bytesTransferred, stats };
}

/** Mínimo de únicos aceitos, como fração do pedido (400 de 500). */
export const MIN_UNIQUE_RATIO = 0.8;
/**
 * Teto de repetição tolerado no bruto. Drift normal observado: até 19,4%
 * (97/500 séries, 39 ciclos de 18 a 28/09/2026) e 15% na medição direta. Uma
 * paginação quebrada (parâmetro `page` ignorado, mesma página repetida) dá
 * ≥ 95%. 35% separa as duas situações com folga; 5% (regra antiga) reprovava
 * o drift normal em 23 de 39 ciclos.
 */
export const MAX_DUP_RATIO = 0.35;
/** Itens do tipo errado tolerados (filme sem `title` / série sem `name`). */
export const MAX_TYPE_MISMATCH_RATIO = 0.05;

/**
 * Guardas contra catálogo corrompido. Lança com mensagem curta e sem URL.
 *
 * Substitui a antiga "sobreposição de IDs filme × série": IDs de filme e de
 * série do TMDB são espaços de numeração distintos (ex.: 121 é "As Duas Torres"
 * como filme e "Doctor Who" como série), então IDs em comum não indicam
 * mistura de tipo e a regra reprovou 8 de 39 ciclos por coincidência. A
 * sanidade de tipo agora olha o formato de cada item.
 */
export function validatePopularBatch(limit: number, movies: PopularFetchResult, series: PopularFetchResult): void {
  const check = (label: string, feminino: boolean, r: PopularFetchResult) => {
    if (r.items.length < limit * MIN_UNIQUE_RATIO) {
      throw new Error(`${feminino ? "Poucas" : "Poucos"} ${label} ${feminino ? "retornadas" : "retornados"}: ${r.items.length}/${limit}`);
    }
    if (r.stats.raw > 0 && r.stats.duplicates / r.stats.raw > MAX_DUP_RATIO) {
      throw new Error(`Duplicidade anômala em ${label}: ${r.stats.duplicates}/${r.stats.raw}`);
    }
    if (r.stats.raw > 0 && r.stats.typeMismatches / r.stats.raw > MAX_TYPE_MISMATCH_RATIO) {
      throw new Error(`Tipo inesperado em ${label}: ${r.stats.typeMismatches}/${r.stats.raw} sem título do tipo`);
    }
  };
  check("filmes", false, movies);
  check("séries", true, series);
}

export const tmdbPopularSource: PopularSource = {
  getPopularMovies: (limit) => collectPopular("/movie/popular", limit, false),
  getPopularSeries: (limit) => collectPopular("/tv/popular",    limit, true),
};
