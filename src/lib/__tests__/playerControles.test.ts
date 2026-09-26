/**
 * Lógica pura dos controles de player. Sem DOM: só as regras de qualidade que o
 * componente `PlayerControls` consome.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  rotuloDeQualidade,
  deveMostrarMenuDeQualidade,
  opcoesDeQualidade,
  seloDeResolucao,
  ehTeclaDeSairDaTelaCheia,
  janelaOcupaATela,
} from "../canais/playerControles";

test("rotuloDeQualidade: altura vira '<n>p'; sem altura vira 'Auto'", () => {
  assert.equal(rotuloDeQualidade(1080), "1080p");
  assert.equal(rotuloDeQualidade(720), "720p");
  assert.equal(rotuloDeQualidade(null), "Auto");
  assert.equal(rotuloDeQualidade(undefined), "Auto");
  assert.equal(rotuloDeQualidade(0), "Auto");
});

test("deveMostrarMenuDeQualidade: só com mais de um nível", () => {
  assert.equal(deveMostrarMenuDeQualidade(0), false);
  assert.equal(deveMostrarMenuDeQualidade(1), false);
  assert.equal(deveMostrarMenuDeQualidade(2), true);
  assert.equal(deveMostrarMenuDeQualidade(5), true);
});

test("opcoesDeQualidade: vazio quando não há variantes reais", () => {
  assert.deepEqual(opcoesDeQualidade([]), []);
  assert.deepEqual(opcoesDeQualidade([1080]), [], "um só nível não é escolha");
});

test("opcoesDeQualidade: Auto (-1) na frente e níveis na ordem, por índice do hls", () => {
  const opcoes = opcoesDeQualidade([1080, 720, null]);
  assert.deepEqual(opcoes, [
    { indice: -1, rotulo: "Auto" },
    { indice: 0, rotulo: "1080p" },
    { indice: 1, rotulo: "720p" },
    { indice: 2, rotulo: "Auto" },
  ]);
});

test("seloDeResolucao: só com altura real; nunca inventa 'Auto'", () => {
  assert.equal(seloDeResolucao(1080), "1080p");
  assert.equal(seloDeResolucao(719.6), "720p");
  assert.equal(seloDeResolucao(0), null);
  assert.equal(seloDeResolucao(null), null);
  assert.equal(seloDeResolucao(undefined), null);
  assert.equal(seloDeResolucao(Number.NaN), null);
});

test("ehTeclaDeSairDaTelaCheia: só Esc", () => {
  assert.equal(ehTeclaDeSairDaTelaCheia("Escape"), true);
  assert.equal(ehTeclaDeSairDaTelaCheia("Esc"), true);
  assert.equal(ehTeclaDeSairDaTelaCheia("Enter"), false);
  assert.equal(ehTeclaDeSairDaTelaCheia("Backspace"), false);
});

test("janelaOcupaATela: detecta a janela saindo da tela cheia", () => {
  const tela = { largura: 1920, altura: 1080 };
  assert.equal(janelaOcupaATela({ largura: 1920, altura: 1080 }, tela), true);
  assert.equal(janelaOcupaATela({ largura: 1919, altura: 1079 }, tela), true, "folga de arredondamento");
  assert.equal(janelaOcupaATela({ largura: 1600, altura: 900 }, tela), false);
  assert.equal(janelaOcupaATela({ largura: 1920, altura: 1040 }, tela), false, "barra de tarefas visível");
});
