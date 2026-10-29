import test from "node:test";
import assert from "node:assert/strict";
import { ofertaDePor } from "../ofertaCortes";

test("sem referência legítima não há De/Por", () => {
  for (const original of [null, undefined, 2700, 1000, 0, -5, 3000.5, "4700", NaN]) {
    assert.equal(ofertaDePor(2700, original), null, String(original));
  }
  assert.equal(ofertaDePor(0, 100), null);
});

test("referência maior que o preço atual mostra De e a economia em centavos", () => {
  assert.deepEqual(ofertaDePor(2700, 4700), { deCentavos: 4700, economiaCentavos: 2000 });
});
