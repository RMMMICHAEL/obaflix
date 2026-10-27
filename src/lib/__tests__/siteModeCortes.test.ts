import { before, test } from "node:test";
import assert from "node:assert/strict";
let decidirRota: typeof import("../../config/site-mode").decidirRota;
before(async () => {
  process.env.WEB_STREAMING_ENABLED = "false";
  ({ decidirRota } = await import("../../config/site-mode"));
});
test("Cortes é público nos três ambientes, sem abrir rotas semelhantes", () => {
  for (const ambiente of ["navegador", "android", "desktop"] as const) {
    assert.deepEqual(decidirRota("/cortes", ambiente), { tipo: "segue" });
  }
  assert.deepEqual(decidirRota("/cortes-falso", "navegador"), {
    tipo: "landing",
  });
  assert.deepEqual(decidirRota("/assistir/filme/1", "navegador"), {
    tipo: "landing",
  });
  for (const rota of ["/planos", "/checkout", "/login", "/cadastro"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "segue" });
  }
  assert.deepEqual(decidirRota("/", "desktop"), {
    tipo: "reescreve",
    para: "/desktop",
  });
  assert.deepEqual(decidirRota("/", "android"), {
    tipo: "reescreve",
    para: "/android",
  });
});
