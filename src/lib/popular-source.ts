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

export interface PopularFetchResult {
  items: PopularItem[];
  bytesTransferred: number;
}

export interface PopularSource {
  getPopularMovies(limit: number): Promise<PopularFetchResult>;
  getPopularSeries(limit: number): Promise<PopularFetchResult>;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface TmdbResult {
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

async function fetchPopular(path: string, limit: number, isSeries = false): Promise<PopularFetchResult> {
  const pages = Math.ceil(limit / PAGE_SIZE);
  const items: PopularItem[] = [];
  let bytesTransferred = 0;
  let rank = 0;

  for (let page = 1; page <= pages; page++) {
    const result = await fetchPageWithRetry(path, page);
    if (!result) break;
    bytesTransferred += result.bytes;
    for (const r of result.results) {
      rank++;
      items.push({
        tmdbId: String(r.id),
        rank,
        titulo: (isSeries ? r.name : r.title) ?? undefined,
        tituloOriginal: (isSeries ? r.original_name : r.original_title) ?? undefined,
        poster: r.poster_path ?? undefined,
        backdrop: r.backdrop_path ?? undefined,
        ano: parseYear(isSeries ? r.first_air_date : r.release_date),
        nota: r.vote_average ?? undefined,
        voteCount: r.vote_count ?? undefined,
        popularidade: r.popularity ?? undefined,
      });
      if (items.length >= limit) return { items, bytesTransferred };
    }
    if (result.results.length === 0) break;
  }
  return { items, bytesTransferred };
}

export const tmdbPopularSource: PopularSource = {
  getPopularMovies: (limit) => fetchPopular("/movie/popular", limit, false),
  getPopularSeries: (limit) => fetchPopular("/tv/popular",    limit, true),
};
