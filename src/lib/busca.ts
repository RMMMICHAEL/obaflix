import { dedupeCanonical, type RegistroCatalogo } from "./canonical";

/**
 * Mescla os dois caminhos da busca num resultado sem repeticao.
 *
 * A busca consulta o catalogo por duas vias em paralelo: o casamento local por
 * titulo normalizado e o cruzamento com os ids que o TMDB devolveu. As duas
 * podem trazer a mesma coisa, e por dois motivos diferentes:
 *
 *  1. a MESMA linha vem pelos dois caminhos — resolvido comparando `id`;
 *  2. o MESMO titulo vem em linhas diferentes, porque o catalogo tinha ate tres
 *     registros para ele. Comparar `id` nao ajuda aqui: os ids sao distintos de
 *     proposito. Pior, o cruzamento faz `WHERE "tmdbId" = ANY(...)` e devolve as
 *     tres linhas de uma vez.
 *
 * Era (2) que fazia "Lanternas" aparecer varias vezes na busca, uma com 3
 * episodios, outra com 0 e outra com 2. `dedupeCanonical` colapsa por tmdbId e
 * mantem o registro mais completo do grupo.
 *
 * Os locais vem primeiro de proposito: eles ja chegam ordenados por nota, e o
 * cruzamento com o TMDB e complemento, nao ranking.
 */
export function mesclarResultadosBusca<T extends RegistroCatalogo>(
  locais: readonly T[],
  porTmdb: readonly T[],
  limite: number,
): T[] {
  const idsLocais = new Set(locais.map((linha) => linha.id));
  const complemento = porTmdb.filter((linha) => !idsLocais.has(linha.id));

  return dedupeCanonical([...locais, ...complemento]).slice(0, limite);
}
