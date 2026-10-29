import test from "node:test";
import assert from "node:assert/strict";
import { enviarEventoMeta, META_PIXEL_ID } from "../metaPixelCortes";

test("sem fbq (sem consentimento) não dispara e não quebra", () => {
  (globalThis as any).window = {};
  assert.doesNotThrow(() => enviarEventoMeta("Purchase", { value: 1 }, "p1"));
});

test("com fbq, envia eventID e nenhum dado pessoal", () => {
  const chamadas: unknown[][] = [];
  (globalThis as any).window = { fbq: (...a: unknown[]) => chamadas.push(a) };
  enviarEventoMeta("Purchase", { currency: "BRL", value: 27 }, "ped1");
  assert.deepEqual(chamadas[0], ["track", "Purchase", { currency: "BRL", value: 27 }, { eventID: "ped1" }]);
  assert.equal(META_PIXEL_ID, "1457288029878728");
});
