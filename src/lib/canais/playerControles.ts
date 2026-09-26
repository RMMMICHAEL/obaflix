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

/**
 * Selo de resolução do canto do player (`1080p`). Diferente do menu, nunca cai
 * para "Auto": sem altura **realmente reportada** pelo player (nível do hls.js
 * em uso ou `videoHeight` no HLS nativo) não há selo — resolução não se fabrica.
 */
export function seloDeResolucao(altura: number | null | undefined): string | null {
  return typeof altura === "number" && Number.isFinite(altura) && altura > 0 ? `${Math.round(altura)}p` : null;
}

/** Tecla que sai da tela cheia do player (Esc), sem fechar o canal. */
export function ehTeclaDeSairDaTelaCheia(tecla: string): boolean {
  return tecla === "Escape" || tecla === "Esc";
}

/**
 * A janela ocupa a tela inteira? Usado para perceber que a **janela** saiu da
 * tela cheia (no Electron, o Esc é consumido pelo processo principal, que só
 * desfaz a tela cheia da janela) enquanto o **elemento** continua em
 * `document.fullscreenElement` — aí o player sai também.
 */
export function janelaOcupaATela(
  janela: { largura: number; altura: number },
  tela: { largura: number; altura: number },
  folga = 2,
): boolean {
  return janela.largura >= tela.largura - folga && janela.altura >= tela.altura - folga;
}
