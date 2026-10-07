import type { TmdbSeasonDetails } from "@/lib/tmdb";

/** Metadata PÚBLICA de um episódio exibida na grade (nunca fonte/URL/provider). */
export interface EpMetadata {
  overview: string | null;
  runtime: number | null;
  thumbnail: string | null;
}

export interface MapasEpisodio {
  /** `${temporada}_${numeroEp}` → nota TMDB (só quando > 0). */
  ratingMap: Record<string, number>;
  /** `${temporada}_${numeroEp}` → overview/runtime/thumbnail. */
  metadataMap: Record<string, EpMetadata>;
}

/**
 * Extrai, de detalhes de temporada do TMDB, os mapas por episódio usados pela
 * grade (overview, runtime, thumbnail e nota). Função pura: não toca em Prisma,
 * nem em urlDub/urlLeg, nem em provider/token — só metadata pública do TMDB.
 *
 * Aceita uma lista de temporadas (uma, no caminho crítico; uma por chamada, no
 * endpoint sob demanda), preservando o mesmo formato de chave que o render usava
 * quando buscava TODAS as temporadas de uma vez.
 */
export function extrairMetadataEpisodios(
  seasons: (TmdbSeasonDetails | null | undefined)[],
): MapasEpisodio {
  const ratingMap: Record<string, number> = {};
  const metadataMap: Record<string, EpMetadata> = {};

  for (const season of seasons) {
    if (!season?.episodes) continue;
    for (const ep of season.episodes) {
      const key = `${ep.season_number}_${ep.episode_number}`;
      if (ep.vote_average > 0) ratingMap[key] = ep.vote_average;
      metadataMap[key] = {
        overview: ep.overview?.trim() || null,
        runtime: ep.runtime ?? null,
        thumbnail: ep.still_path ?? null,
      };
    }
  }

  return { ratingMap, metadataMap };
}
