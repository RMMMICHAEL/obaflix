import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { criarContagemAndroid, DURACAO_CONTAGEM_ANDROID_MS } from "../ads/contagemAndroid";

/**
 * A contagem regressiva do convite no Android, sem React e sem DOM.
 *
 * O relógio e a visibilidade são injetados: cada teste controla o tempo e o
 * primeiro/segundo plano na mão, e o que se prova é exatamente o que um
 * `setInterval` com `document.visibilityState` esconderia — que o anúncio não
 * abre cedo, que abre uma única vez, que o tempo parado em background não é
 * descontado, e que encerrar é definitivo.
 */

function cenario(duracaoMs = DURACAO_CONTAGEM_ANDROID_MS) {
  let agora = 0;
  let visivel = true;
  let zeros = 0;
  const c = criarContagemAndroid({
    agora: () => agora,
    visivel: () => visivel,
    aoZerar: () => {
      zeros++;
    },
    duracaoMs,
  });
  return {
    c,
    /** Avança o relógio `ms` e bate uma passada, como faria o `setInterval`. */
    tique(ms: number) {
      agora += ms;
      c.avancar();
    },
    /** A página foi para segundo plano. */
    ocultar() {
      visivel = false;
    },
    /** A página voltou — como o listener de `visibilitychange` reancora o relógio. */
    mostrar() {
      visivel = true;
      c.marcarVisivel();
    },
    /** Só passa o tempo de parede, sem bater passada (intervalo congelado). */
    passarTempo(ms: number) {
      agora += ms;
    },
    get zeros() {
      return zeros;
    },
  };
}

describe("a contagem do Android", () => {
  /** Cenário 1: nada dispara antes dos 3 s. */
  test("não dispara antes de zerar, e mostra 3 → 2 → 1", () => {
    const s = cenario();
    assert.equal(s.c.segundosRestantes(), 3, "o convite abre em 3");

    s.tique(1000);
    assert.equal(s.c.segundosRestantes(), 2);
    assert.equal(s.zeros, 0);

    s.tique(1000);
    assert.equal(s.c.segundosRestantes(), 1);
    assert.equal(s.zeros, 0);

    // 2,9 s no total: ainda não zerou.
    s.tique(900);
    assert.equal(s.zeros, 0, "aos 2,9 s o anúncio ainda não pode abrir");
  });

  /** Cenário 2: ao zerar, dispara exatamente uma vez — nunca duas. */
  test("dispara uma única vez ao cruzar o zero", () => {
    const s = cenario();
    s.tique(1000);
    s.tique(1000);
    s.tique(1000); // 3,0 s — zera aqui
    assert.equal(s.zeros, 1);

    // Mais passadas, e passadas repetidas no mesmo instante, não reabrem.
    s.tique(1000);
    s.c.avancar();
    s.c.avancar();
    assert.equal(s.zeros, 1, "rerender/toque repetido/timer concorrente não disparam de novo");
    assert.equal(s.c.segundosRestantes(), 0);
  });

  /** Cenário 3: em segundo plano o tempo não é descontado. */
  test("segundo plano pausa a contagem", () => {
    const s = cenario();
    s.tique(1000);
    assert.equal(s.c.segundosRestantes(), 2);

    s.ocultar();
    // Passadas em background não descontam, mesmo com muito tempo de parede.
    s.tique(5000);
    s.tique(5000);
    assert.equal(s.c.segundosRestantes(), 2, "o texto congela no último valor visível");
    assert.equal(s.zeros, 0, "em background o anúncio nunca abre sozinho");
  });

  /** Cenário 4: ao voltar ao primeiro plano, conta só o tempo visível que falta. */
  test("voltar ao primeiro plano retoma de onde parou", () => {
    const s = cenario();
    s.tique(1000); // restam 2 s de tempo visível
    s.ocultar();
    s.tique(5000); // ignorado
    s.mostrar();

    s.tique(1000);
    assert.equal(s.c.segundosRestantes(), 1);
    assert.equal(s.zeros, 0);

    s.tique(1000); // completa os 2 s visíveis que faltavam
    assert.equal(s.zeros, 1, "dispara após o tempo visível, não o tempo de parede");
  });

  /**
   * Cenário 4, o caso difícil: o intervalo pode congelar de vez em background
   * (WebView com o app atrás). Sem passada nenhuma durante o tempo parado,
   * reancorar ao voltar é o que impede "queimar" os 3 s de uma vez.
   */
  test("intervalo congelado em background não queima a contagem ao voltar", () => {
    const s = cenario();
    s.tique(1000); // restam 2 s
    s.ocultar();
    s.passarTempo(60000); // 1 min parado, nenhuma passada
    s.mostrar();

    // A primeira passada visível mede a partir do retorno, não do minuto parado.
    s.tique(1000);
    assert.equal(s.zeros, 0, "o minuto em background não pode contar como os 3 s");
    assert.equal(s.c.segundosRestantes(), 1);

    s.tique(1000);
    assert.equal(s.zeros, 1);
  });

  /** Cenário 5: cancelar antes do zero não exibe anúncio nenhum depois. */
  test("encerrar antes do zero impede qualquer disparo posterior", () => {
    const s = cenario();
    s.tique(1000);
    s.c.encerrar();

    s.tique(5000);
    s.tique(5000);
    assert.equal(s.zeros, 0, "depois de cancelado, nenhuma passada dispara");
    assert.equal(s.c.segundosRestantes(), 0);
  });

  /**
   * Cenário 10, no nível da contagem: os 3 s só chamam `aoZerar`. Não há aqui
   * nenhuma concessão, nenhum acesso — abrir o anúncio é o único efeito, e a
   * liberação continua a depender do callback nativo e do servidor.
   */
  test("o único efeito de zerar é chamar aoZerar, nada mais", () => {
    let efeitos = 0;
    let agora = 0;
    const c = criarContagemAndroid({
      agora: () => agora,
      visivel: () => true,
      aoZerar: () => {
        efeitos++;
      },
    });
    for (let i = 0; i < 3; i++) {
      agora += 1000;
      c.avancar();
    }
    assert.equal(efeitos, 1, "zerar não concede acesso: só sinaliza que é hora de exibir");
  });
});
