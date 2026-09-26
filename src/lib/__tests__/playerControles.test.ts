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
