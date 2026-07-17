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

async function fetchPageWithRetry(path: string, page: number): Promise<{ results: { id: number }[]; bytes: number } | null> {
  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    // AbortController manual em vez de AbortSignal.timeout(): visto em scripts
    // desta sessão que o timer interno do AbortSignal.timeout() pode lançar
    // fora da cadeia de promises do fetch sob concorrência (bug do fetch
    // nativo do Node/undici) — abort() manual num setTimeout é mais estável.
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

async function fetchPopular(path: string, limit: number): Promise<PopularFetchResult> {
  const pages = Math.ceil(limit / PAGE_SIZE);
  const items: PopularItem[] = [];
  let bytesTransferred = 0;
  let rank = 0;

  // Sequencial (não paralelo): a ordem das páginas define o rank, e o TMDB
  // pagina de forma estável o suficiente pra isso valer a pena manter simples.
  for (let page = 1; page <= pages; page++) {
    const result = await fetchPageWithRetry(path, page);
    if (!result) break; // página falhou mesmo após retry — para aqui, guarda de sanidade no cron cuida do resto
    bytesTransferred += result.bytes;
    for (const r of result.results) {
      rank++;
      items.push({ tmdbId: String(r.id), rank });
      if (items.length >= limit) return { items, bytesTransferred };
    }
    if (result.results.length === 0) break;
  }
  return { items, bytesTransferred };
}

export const tmdbPopularSource: PopularSource = {
  getPopularMovies: (limit) => fetchPopular("/movie/popular", limit),
  getPopularSeries: (limit) => fetchPopular("/tv/popular", limit),
};
