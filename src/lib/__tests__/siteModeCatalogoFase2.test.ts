import { test } from "node:test";
import assert from "node:assert/strict";

import { decidirRota } from "@/config/site-mode";

/**
 * Fase 2: páginas agregadoras públicas (/filmes, /series, /genero) com o
 * streaming web fechado. O player continua fechado e os apps seguem como antes.
 */

test("navegador: /filmes, /series e /genero (canônico e legado) seguem", () => {
  for (const rota of ["/filmes", "/series", "/genero/crime--80", "/genero/80"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "segue" }, rota);
  }
});

test("navegador: prefixos parecidos continuam fechados", () => {
  for (const rota of ["/filmes-falso", "/series-falso", "/genero-falso", "/generos"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "landing" }, rota);
  }
});

test("navegador: o player continua fechado", () => {
  for (const rota of ["/assistir/filme/abc", "/assistir/serie/abc/t1/ep1", "/player", "/player/x"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "landing" }, rota);
  }
});

test("Android e Electron seguem nas agregadoras e no player (homologado)", () => {
  for (const ambiente of ["android", "desktop"] as const) {
    for (const rota of ["/filmes", "/series", "/genero/crime--80", "/assistir/filme/abc", "/player"]) {
      assert.deepEqual(decidirRota(rota, ambiente), { tipo: "segue" }, `${ambiente}: ${rota}`);
    }
  }
});
