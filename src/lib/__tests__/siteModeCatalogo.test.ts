import { test } from "node:test";
import assert from "node:assert/strict";

import { decidirRota } from "@/config/site-mode";

/**
 * Fichas de catálogo públicas com o streaming web fechado.
 *
 * O navegador comum passa a ver `/filme/<id>` e `/serie/<id>` (páginas de
 * informação e indexáveis), mas o player (`/assistir`, `/player`) continua
 * fechado, e Android, Electron e as APIs seguem exatamente como antes.
 *
 * Sem definir WEB_STREAMING_ENABLED: ausente é fechado, que é o modo em teste.
 */

test("navegador comum: fichas de filme e série seguem", () => {
  for (const rota of ["/filme/abc", "/filme/abc/", "/serie/abc", "/serie/abc/temporada"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "segue" }, rota);
  }
});

test("navegador comum: prefixo parecido não herda a abertura", () => {
  for (const rota of ["/filme-falso", "/serie-falsa", "/filmes", "/series", "/filmez", "/seriex"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "landing" }, rota);
  }
});

test("navegador comum: o player continua fechado", () => {
  for (const rota of [
    "/assistir/filme/abc",
    "/assistir/serie/abc/t1/ep1",
    "/player",
    "/player/qualquer",
  ]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "landing" }, rota);
  }
});

test("aplicativos e APIs inalterados nas fichas e no player", () => {
  for (const ambiente of ["android", "desktop"] as const) {
    for (const rota of [
      "/filme/abc",
      "/serie/abc",
      "/assistir/filme/abc",
      "/assistir/serie/abc/t1/ep1",
      "/player",
    ]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: "segue" }, `${ambiente}: ${rota}`);
    }
  }
  for (const ambiente of ["navegador", "android", "desktop"] as const) {
    for (const rota of ["/api", "/api/player/proxy", "/api/auth/session"]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: "segue" }, `${ambiente}: ${rota}`);
    }
  }
});
