import test from "node:test";
import assert from "node:assert/strict";
import { mascararTempo, segundosDoTexto, ajustarIntervalo, textoDoTempo, cursorDaMascara, parsearCenas } from "../recorte";

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
test("parsearCenas: intervalos por linha, vírgula, traço longo e pares sem traço", () => {
  const umaPorLinha = parsearCenas("10:59-11:50\n12:00-12:30", 3600);
  assert.deepEqual(umaPorLinha, { cenas: [{ inicio: 659, fim: 710 }, { inicio: 720, fim: 750 }], ignoradas: 0 });
  // vírgula separa intervalos na mesma linha; traço en/em também vale.
  assert.deepEqual(parsearCenas("00:10-00:20, 00:30–00:40", 3600).cenas,
    [{ inicio: 10, fim: 20 }, { inicio: 30, fim: 40 }]);
  // horários sem traço, separados por vírgula, pareados em sequência.
  assert.deepEqual(parsearCenas("00:10, 00:20", 3600).cenas, [{ inicio: 10, fim: 20 }]);
});
test("parsearCenas: descarta inválidos e clampa na duração", () => {
  const r = parsearCenas("00:10-00:05\n0:60-1:00\nabc\n00:50-02:00\n01:00-00:00-00:30", 100);
  // fim<=início, mm:60 inválido, texto não-horário e três pontas são ignorados;
  // 00:50-02:00 clampa o fim em 100 s.
  assert.deepEqual(r.cenas, [{ inicio: 50, fim: 100 }]);
  assert.equal(r.ignoradas, 4);
  // início além da duração é descartado.
  assert.deepEqual(parsearCenas("02:00-03:00", 60), { cenas: [], ignoradas: 1 });
});
