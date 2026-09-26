/**
 * Watchdog de stall — lógica pura, relógio injetado. Sem DOM.
 *
 * O teto de 3 re-resoluções em 60 s e o single-flight NÃO são testados aqui:
 * vivem em `criarControleDeCanal` (ver `canaisHandoff.test.ts`). O watchdog só
 * decide **quando** chamar a re-resolução — e o que se prova aqui é que ele
 * dispara **uma vez por stall**, respeita pausa e reseta no progresso.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { criarWatchdogDeStall } from "../canais/watchdogDeStall";

test("stall além do limiar dispara uma única vez", () => {
  const w = criarWatchdogDeStall({ limiarMs: 7000 });
  w.progrediu(0, 0); // começou a tocar em t=0, currentTime=0

  // Antes do limiar: nada.
  assert.equal(w.deveReresolver(6999), false);
  // No limiar: dispara.
  assert.equal(w.deveReresolver(7000), true);
  // E não repete no mesmo stall (sem novo progresso).
  assert.equal(w.deveReresolver(8000), false);
  assert.equal(w.deveReresolver(20000), false);
});

test("progresso real reseta o relógio do stall (buffering curto não dispara)", () => {
  const w = criarWatchdogDeStall({ limiarMs: 7000 });
  w.progrediu(0, 0);
  // Avança de pouquinho em pouquinho — nunca fica 7s parado.
  w.progrediu(3, 3000);
  assert.equal(w.deveReresolver(6000), false); // 3s desde o último avanço
  w.progrediu(6, 6000);
  assert.equal(w.deveReresolver(9000), false); // 3s desde o último avanço
  w.progrediu(12, 12000);
  assert.equal(w.deveReresolver(18000), false); // 6s < 7s
});

test("avanço abaixo do epsilon é ruído e NÃO reseta", () => {
  const w = criarWatchdogDeStall({ limiarMs: 7000 });
  w.progrediu(10, 0);
  // currentTime praticamente parado (jitter): não conta como progresso.
  w.progrediu(10.01, 3000);
  w.progrediu(10.005, 5000);
  assert.equal(w.deveReresolver(7000), true, "parado desde t=0 apesar do jitter");
});

test("pausa voluntária nunca dispara; retomar dá carência", () => {
  const w = criarWatchdogDeStall({ limiarMs: 7000 });
  w.progrediu(0, 0);
  w.definirPausado(true, 1000);
  // Mesmo muito tempo pausado, não dispara.
  assert.equal(w.deveReresolver(60000), false);
  // Ao retomar, o relógio zera (carência): não conta o tempo pausado.
  w.definirPausado(false, 60000);
  assert.equal(w.deveReresolver(66000), false, "6s após retomar < 7s");
  assert.equal(w.deveReresolver(67000), true, "7s após retomar, aí sim");
});

test("recuperação (novo avanço) reabre para um próximo stall", () => {
  const w = criarWatchdogDeStall({ limiarMs: 7000 });
  w.progrediu(0, 0);
  assert.equal(w.deveReresolver(7000), true); // 1º stall dispara

  // A reprodução volta a avançar (recuperou).
  w.progrediu(5, 8000);
  assert.equal(w.deveReresolver(9000), false, "recuperado, não dispara");

  // Um NOVO stall, 7s sem avanço, dispara de novo (uma vez).
  assert.equal(w.deveReresolver(15000), true);
  assert.equal(w.deveReresolver(16000), false);
});

test("não dispara antes do primeiro avanço (abertura/carregando não é stall)", () => {
  const w = criarWatchdogDeStall({ limiarMs: 7000 });
  // Nunca chamou progrediu: está abrindo, não tocando.
  assert.equal(w.deveReresolver(60000), false);
  assert.equal(w.emStall(60000), false);
});

test("emStall reflete o estado sem consumir o disparo", () => {
  const w = criarWatchdogDeStall({ limiarMs: 7000 });
  w.progrediu(0, 0);
  assert.equal(w.emStall(6999), false);
  assert.equal(w.emStall(7000), true);
  // emStall não "arma" o disparo: deveReresolver ainda pode disparar uma vez.
  assert.equal(w.deveReresolver(7000), true);
  assert.equal(w.deveReresolver(7000), false);
});
