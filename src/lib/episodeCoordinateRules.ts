import type { RegraCoordenada } from "./episodeCoordinates";

/**
 * Exceções de coordenada por tmdbId + provedor. Só servidor: nunca vai ao
 * cliente, e o provedor aqui é o slug interno de `detectarProvider`.
 *
 * Para acrescentar um título: uma entrada nova, sem tocar no resolvedor. Toda
 * regra precisa de evidência medida na `nota` — uma regra errada toca o
 * episódio errado com HTTP 200, e isso nenhuma validação de mídia pega.
 */
export const REGRAS_COORDENADA: ReadonlyArray<RegraCoordenada> = [
  // Hunter x Hunter (2011). Catálogo: 6 temporadas por arco (26/12/20/17/61/12
  // = 148). Provedores: divisão TMDB 62/74/12.
  {
    tipo: "divisao",
    tmdbId: "46298",
    provider: "watchplayer",
    temporadas: [62, 74, 12],
    numeracao: "relativa",
    antesDoCanonico: true,
    nota:
      "28/09/2026: CDN com s1e1..s1e62 (s1e63+ = 404), s2e1..s2e74 (2/75 sem player), s3e1..s3e12. "
      + "T2E1 canônico devolve s2e1 = absoluto 63, não o 27 do catálogo.",
  },
  {
    tipo: "divisao",
    tmdbId: "46298",
    provider: "playerflix",
    temporadas: [62, 74, 12],
    numeracao: "absoluta",
    antesDoCanonico: true,
    nota:
      "28/09/2026: Ajax.php com prev/next (episódio próprio) em S1E1..E62, S2E63..E136, S3E137..E148. "
      + "T2E1 responde status:true só com embeds externos na mesma coordenada (WatchPlay s2e1 = absoluto 63).",
  },
];
