/**
 * Lógica pura dos controles de player — sem React, sem DOM.
 *
 * Fica aqui, e não dentro do componente, para poder ser testada sem montar UI.
 * Só regras triviais e determinísticas: rótulo de qualidade e a decisão de
 * mostrar (ou não) o menu de qualidade. O resto dos controles é glue de
 * `<video>`/`hls.js`/Remote Playback, que não rende teste unitário honesto.
 */

/** Rótulo de um nível de qualidade a partir da altura. Sem altura conhecida, "Auto". */
export function rotuloDeQualidade(altura: number | null | undefined): string {
  return typeof altura === "number" && altura > 0 ? `${altura}p` : "Auto";
}

/**
 * O menu de qualidade só aparece quando há **variantes reais** para escolher.
 * Um único nível (ou nenhum, como no HLS nativo) não é escolha — é ruído.
 */
export function deveMostrarMenuDeQualidade(quantidadeDeNiveis: number): boolean {
  return quantidadeDeNiveis > 1;
}

/** Um item de qualidade já pronto para a UI. */
export interface OpcaoDeQualidade {
  /** Índice para `onSelecionar`. `-1` é "Auto" (deixa o ABR decidir). */
  indice: number;
  rotulo: string;
}

/**
 * Monta as opções do menu a partir das alturas dos níveis do hls.js.
 * Devolve lista vazia quando não há variantes (o menu não deve aparecer):
 * assim o componente decide só olhando `opcoes.length`.
 *
 * Quando há variantes, a primeira opção é sempre **Auto** (`indice -1`), seguida
 * dos níveis na ordem recebida (`indice` = índice do nível no hls.js).
 */
export function opcoesDeQualidade(alturasDosNiveis: (number | null | undefined)[]): OpcaoDeQualidade[] {
  if (!deveMostrarMenuDeQualidade(alturasDosNiveis.length)) return [];
  return [
    { indice: -1, rotulo: "Auto" },
    ...alturasDosNiveis.map((altura, i) => ({ indice: i, rotulo: rotuloDeQualidade(altura) })),
  ];
}
