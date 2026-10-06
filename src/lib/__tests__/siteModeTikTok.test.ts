import { before, test } from "node:test";
import assert from "node:assert/strict";

// Definir antes do import: este teste cobre o site com streaming web fechado,
// independentemente das variáveis do ambiente que executa a validação.
let decidirRota: typeof import("../../config/site-mode").decidirRota;
before(async () => {
  process.env.WEB_STREAMING_ENABLED = "false";
  ({ decidirRota } = await import("../../config/site-mode"));
});

test("campanha TikTok pública, sem liberar prefixos parecidos", () => {
  for (const rota of ["/tiktok", "/tiktok/", "/tiktok/campanha"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "segue" }, rota);
  }
  assert.deepEqual(decidirRota("/tiktok-falso", "navegador"), { tipo: "landing" });
});

test("raiz, entradas dos apps, pareamento e APIs mantêm o roteamento", () => {
  for (const ambiente of ["navegador", "android", "desktop"] as const) {
    assert.deepEqual(decidirRota("/", ambiente), ambiente === "navegador"
      ? { tipo: "segue" }
      : { tipo: "reescreve", para: ambiente === "android" ? "/android" : "/desktop" });
    for (const rota of ["/android", "/android/perfil"]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: ambiente === "android" ? "segue" : "landing" });
    }
    for (const rota of ["/desktop", "/desktop/perfil"]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: ambiente === "desktop" ? "segue" : "landing" });
    }
    for (const rota of ["/parear", "/api", "/api/auth/session", "/api/player/proxy", "/api/admin/catalogo"]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: "segue" }, `${ambiente}: ${rota}`);
    }
  }
});
