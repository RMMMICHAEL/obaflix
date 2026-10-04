import test from "node:test";
import assert from "node:assert/strict";
import { mascararTempo, segundosDoTexto, ajustarIntervalo, textoDoTempo, cursorDaMascara } from "../recorte";

test("digitação numérica contínua e estados parciais", () => {
  assert.deepEqual(["", "1", "11", "111", "1119"].map(mascararTempo), ["", "1", "11", "1:11", "11:19"]);
  assert.equal(segundosDoTexto("11:19"), 679);
  assert.equal(segundosDoTexto("01:11:19"), 4279);
  assert.equal(mascararTempo("011119"), "01:11:19");
  for (const parcial of ["", "1", "11:", "01:11:", "01:11:1"]) assert.equal(segundosDoTexto(parcial), null);
  assert.equal(segundosDoTexto("11:99"), null);
  assert.equal(mascararTempo("a11b19"), "11:19");
});
test("Backspace, Delete e substituição mantêm dígitos e cursor", () => {
  assert.equal(mascararTempo("11:1"), "1:11");
  assert.equal(mascararTempo("1:19"), "1:19");
  assert.equal(mascararTempo("20:00"), "20:00");
  assert.equal(cursorDaMascara("1119", 4, "11:19"), 5);
  assert.equal(cursorDaMascara("1119", 1, "11:19"), 1);
});
test("início empurra fim; fim não cruza início; clamp na duração", () => {
  assert.deepEqual(ajustarIntervalo("inicio", 60, 10, 50, 180), { inicio: 60, fim: 61 });
  assert.deepEqual(ajustarIntervalo("inicio", 999, 10, 50, 180), { inicio: 179, fim: 180 });
  assert.deepEqual(ajustarIntervalo("fim", 1, 60, 80, 180), { inicio: 60, fim: 61 });
  assert.deepEqual(ajustarIntervalo("fim", 999, 60, 80, 180), { inicio: 60, fim: 180 });
  assert.equal(textoDoTempo(679), "11:19");
  assert.equal(textoDoTempo(4279), "01:11:19");
  assert.equal(textoDoTempo(61 - 60), "00:01");
});
