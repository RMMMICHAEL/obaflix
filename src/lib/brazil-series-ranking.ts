import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getRedis, type RedisClient } from "./redis";
import { serieDisponivel } from "./catalog-availability";

type Window = "day" | "week" | "month";
export const BRAZIL_SERIES_CATEGORIES = {
  day: "DAILY_POPULARITY_SAME_CONTENT_TYPE",
  week: "WEEKLY_POPULARITY_SAME_CONTENT_TYPE",
  month: "MONTHLY_POPULARITY_SAME_CONTENT_TYPE",
} as const;
export const BRAZIL_SERIES_ENDPOINT = "https://apis.justwatch.com/graphql";
export const BRAZIL_SERIES_EXCLUDED_GENRES = [10763, 10764, 10767];
export const BRAZIL_SERIES_FRESH_TTL = 3600;
export const BRAZIL_SERIES_LAST_GOOD_TTL = 30 * 24 * 60 * 60;
// Duas janelas de até 500 entradas; filtrar antes de paginar esse universo.
export const BRAZIL_SERIES_BROWSE_LIMIT = 1000;
export const BRAZIL_SERIES_MIN_IMDB_IDS = 25;

export function brazilSeriesQuery(window: Window): string {
  return `query { streamingCharts(country: BR, first: 500,
    filter: {objectType: SHOW, category: ${BRAZIL_SERIES_CATEGORIES[window]}}) {
    edges { streamingChartInfo { rank } node { id objectType
      content(country: BR, language: pt) { title externalIds { imdbId } }
    } }
  } }`;
}

/** Valida o contrato público; títulos nunca são usados para casar o catálogo. */
export function parseBrazilSeriesRanking(payload: unknown): string[] {
  const result = payload as { errors?: unknown; data?: { streamingCharts?: { edges?: unknown } } };
  const edges = result?.data?.streamingCharts?.edges;
  if (result?.errors || !Array.isArray(edges) || !edges.length) {
    throw new Error("Resposta inválida de Streaming Charts BR");
  }
  const entries: { imdbId: string; rank: number }[] = [];
  for (const edge of edges) {
    if (edge?.node?.objectType !== "SHOW" || !Number.isInteger(edge?.streamingChartInfo?.rank)
      || edge.streamingChartInfo.rank < 1) throw new Error("Contrato de Streaming Charts BR mudou");
    const imdbId = edge.node.content?.externalIds?.imdbId;
    if (typeof imdbId === "string" && /^tt\d+$/.test(imdbId)) {
      entries.push({ imdbId, rank: edge.streamingChartInfo.rank });
    }
  }
  if (!entries.length) throw new Error("Streaming Charts BR sem IMDb IDs válidos");
  return [...new Set(entries.sort((a, b) => a.rank - b.rank).map((entry) => entry.imdbId))];
}

/** Não deixar HTTP 200 com contrato degradado destruir o último snapshot bom. */
export function parseBrazilSeriesLiveSnapshot(payload: unknown): string[] {
  const ids = parseBrazilSeriesRanking(payload);
  const count = (payload as { data: { streamingCharts: { edges: unknown[] } } }).data.streamingCharts.edges.length;
  if (count > 500 || ids.length < BRAZIL_SERIES_MIN_IMDB_IDS || ids.length < Math.ceil(count / 2)) {
    throw new Error("Cobertura IMDb insuficiente em Streaming Charts BR");
  }
  return ids;
}

/** IN não ordena linhas. Também omite itens removidos entre as duas consultas. */
export function orderBrazilSeriesRows<T extends { id: string }>(ids: string[], rows: T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...new Set(ids)].flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** As linhas já foram filtradas no banco: total e páginas refletem esses filtros. */
export function paginateBrazilSeriesRows<T extends { id: string }>(ids: string[], rows: T[], page: number, limit: number) {
  const ordered = orderBrazilSeriesRows(ids, rows);
  return { series: ordered.slice((page - 1) * limit, page * limit), total: ordered.length };
}

type Dependencies = {
  fetch: typeof fetch;
  cache: () => Pick<RedisClient, "get" | "set">;
  findSeries: (where: Prisma.SerieWhereInput) => Promise<{ id: string; imdbId: string | null }[]>;
};

function readSnapshot(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) && ids.length > 0 && ids.length <= 500 && ids.every((id) => typeof id === "string" && /^tt\d+$/.test(id))
      ? [...new Set(ids)] : null;
  } catch { return null; }
}

/** Cacheia somente a fonte externa; disponibilidade local é reavaliada sempre. */
export function createBrazilSeriesRanking(deps: Dependencies) {
  const pending = new Map<Window, Promise<string[]>>();
  async function snapshot(window: Window): Promise<string[]> {
    const existing = pending.get(window);
    if (existing) return existing;
    const request = (async () => {
      const cache = deps.cache();
      const prefix = `catalog:br:series:${window}`;
      const fresh = readSnapshot(await cache.get(`${prefix}:fresh:v1`).catch(() => null));
      if (fresh) return fresh;
      try {
        const response = await deps.fetch(BRAZIL_SERIES_ENDPOINT, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: brazilSeriesQuery(window) }),
          signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "error",
        });
        if (!response.ok) throw new Error("Streaming Charts BR indisponível");
        const ids = parseBrazilSeriesLiveSnapshot(await response.json());
        const value = JSON.stringify(ids);
        await Promise.all([
          cache.set(`${prefix}:fresh:v1`, value, { ex: BRAZIL_SERIES_FRESH_TTL }),
          cache.set(`${prefix}:last-good:v1`, value, { ex: BRAZIL_SERIES_LAST_GOOD_TTL }),
        ]).catch(() => undefined);
        return ids;
      } catch {
        return readSnapshot(await cache.get(`${prefix}:last-good:v1`).catch(() => null)) ?? [];
      }
    })();
    pending.set(window, request);
    try { return await request; } finally { pending.delete(window); }
  }

  return async (window: "day" | "week", limit: number): Promise<string[]> => {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const resolve = async (imdbIds: string[]) => {
      if (!imdbIds.length) return [];
      const rows = await deps.findSeries(serieDisponivel({
        tipo: "serie", imdbId: { in: imdbIds },
        NOT: { generos: { some: { generoId: { in: BRAZIL_SERIES_EXCLUDED_GENRES } } } },
      }));
      // IMDb não é UNIQUE: escolha determinística entre cópias locais elegíveis.
      const byImdb = new Map<string, string>();
      for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
        if (row.imdbId && !byImdb.has(row.imdbId)) byImdb.set(row.imdbId, row.id);
      }
      return imdbIds.flatMap((id) => byImdb.has(id) ? [byImdb.get(id)!] : []);
    };
    const primary = await resolve(await snapshot(window));
    if (primary.length >= limit) return primary.slice(0, limit);
    const secondary = await resolve(await snapshot(window === "day" ? "week" : "month"));
    return [...new Set([...primary, ...secondary])].slice(0, limit);
  };
}

export const getBrazilSeriesRanking = createBrazilSeriesRanking({
  fetch: (...args) => fetch(...args),
  cache: getRedis,
  findSeries: (where) => prisma.serie.findMany({ where, select: { id: true, imdbId: true } }),
});
