/**
 * Paginacao de telas que somam DUAS consultas independentes.
 *
 * /genero/[id] mostra filmes e series lado a lado, mas cada um vem da sua
 * propria rota, com o seu proprio total. A versao anterior usava um numero de
 * pagina so para as duas e somava os totais para decidir se ainda havia mais:
 * quando uma das listas acabava, "Carregar mais" continuava pedindo paginas
 * vazias dela e a grade nunca alcancava o total anunciado.
 *
 * A logica vive aqui, fora do componente, para poder ser verificada sem montar
 * React — o defeito era aritmetico, nao visual.
 */

export interface EstadoFonte {
  /** Ultima pagina JA carregada. Zero significa "nada ainda". */
  page: number;
  /** Total informado pela API na ultima resposta. */
  total: number;
  /** Quantos itens desta fonte ja estao na tela. */
  carregados: number;
  /** Nao adianta pedir mais: ou acabou, ou a ultima resposta veio vazia. */
  esgotada: boolean;
}

export const fonteZerada = (): EstadoFonte => ({
  page: 0,
  total: 0,
  carregados: 0,
  esgotada: false,
});

/**
 * Incorpora uma resposta e diz se a fonte acabou.
 *
 * Duas condicoes de parada, nao uma. `carregados >= total` cobre o caso normal;
 * `recebidos === 0` cobre o total que veio errado ou desatualizado — sem ele,
 * um total inflado deixaria o botao pedindo paginas vazias para sempre.
 */
export function avancarFonte(
  estado: EstadoFonte,
  recebidos: number,
  total: number | undefined,
): EstadoFonte {
  const totalAtual = total ?? estado.total;
  const carregados = estado.carregados + recebidos;

  return {
    page: estado.page + 1,
    total: totalAtual,
    carregados,
    esgotada: recebidos === 0 || carregados >= totalAtual,
  };
}

/** A proxima pagina a pedir, ou `null` quando a fonte ja se esgotou. */
export function proximaPagina(estado: EstadoFonte): number | null {
  return estado.esgotada ? null : estado.page + 1;
}

/** Ainda ha o que carregar enquanto QUALQUER uma das fontes tiver sobra. */
export function temMais(...fontes: EstadoFonte[]): boolean {
  return fontes.some((fonte) => !fonte.esgotada);
}

/** Total exibido ao usuario: a soma do que as duas fontes informaram. */
export function totalCombinado(...fontes: EstadoFonte[]): number {
  return fontes.reduce((soma, fonte) => soma + fonte.total, 0);
}

/**
 * Intercala duas listas para a grade nao virar "todos os filmes, depois todas
 * as series". Sobra do lado mais longo vai para o fim.
 */
export function intercalar<T>(a: readonly T[], b: readonly T[]): T[] {
  const saida: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) saida.push(a[i]);
    if (i < b.length) saida.push(b[i]);
  }
  return saida;
}
