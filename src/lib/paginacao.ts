/**
 * Detecção de próxima página sem COUNT.
 *
 * A consulta busca `porPagina + 1` linhas (a última é uma sonda). Se a sonda
 * voltar, existe página seguinte; a sonda é descartada antes de renderizar. O
 * `skip` de quem chama continua múltiplo de `porPagina` — a sonda nunca desloca
 * o início da página seguinte.
 *
 * Isto corrige o falso positivo do `length === porPagina`: uma página exatamente
 * cheia (ex. 30 de 30) não é mais confundida com "há mais", o que levava a um
 * link "Próxima" apontando para uma página vazia (404).
 */
export function takeComSonda(porPagina: number): number {
  return porPagina + 1;
}

export interface PaginaFatiada<F, S> {
  filmes: F[];
  series: S[];
  temProxima: boolean;
}

/**
 * Recebe os resultados crus (até `porPagina + 1` de cada), decide se há próxima
 * e devolve no máximo `porPagina` de cada lado para exibição.
 */
export function fatiarPagina<F, S>(
  filmes: F[],
  series: S[],
  porPagina: number,
): PaginaFatiada<F, S> {
  return {
    filmes: filmes.slice(0, porPagina),
    series: series.slice(0, porPagina),
    temProxima: filmes.length > porPagina || series.length > porPagina,
  };
}
