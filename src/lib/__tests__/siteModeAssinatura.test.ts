import { test } from "node:test";
import assert from "node:assert/strict";

import { decidirRota } from "@/config/site-mode";
import { caminhoInternoSeguro, destinoDoLoginDoCheckout, planoEscolhidoDaUrl } from "../billing/checkout";

/**
 * Continuação da assinatura no navegador do celular.
 *
 * O QR da TV leva a `/planos?plano=<id>`. Só as páginas de assinatura abrem para
 * navegador comum; o streaming web continua fechado.
 */

test("navegador comum: planos, checkout e conta abertos", () => {
  for (const rota of ["/planos", "/checkout", "/conta", "/login", "/cadastro"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "segue" }, rota);
  }
});

test("navegador comum: streaming continua fechado", () => {
  for (const rota of ["/filmes", "/series", "/assistir/abc", "/canais", "/busca", "/android", "/desktop", "/perfil"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "landing" }, rota);
  }
});

test("prefixo parecido não herda a abertura", () => {
  for (const rota of ["/planosx", "/checkout-falso", "/contas"]) {
    assert.deepEqual(decidirRota(rota, "navegador"), { tipo: "landing" }, rota);
  }
});

test("aplicativos seguem como antes", () => {
  for (const rota of ["/planos", "/checkout", "/conta"]) {
    assert.deepEqual(decidirRota(rota, "android"), { tipo: "segue" }, rota);
    assert.deepEqual(decidirRota(rota, "desktop"), { tipo: "segue" }, rota);
  }
  assert.deepEqual(decidirRota("/", "android"), { tipo: "reescreve", para: "/android" });
});

test("checkout sem sessão vai ao login e volta com plano e preço", () => {
  const destino = destinoDoLoginDoCheckout("planoId=plus&planoPrecoId=preco_1");
  assert.equal(destino, "/login?callbackUrl=%2Fcheckout%3FplanoId%3Dplus%26planoPrecoId%3Dpreco_1");
  const volta = new URLSearchParams(destino.split("?")[1]).get("callbackUrl");
  assert.equal(caminhoInternoSeguro(volta), "/checkout?planoId=plus&planoPrecoId=preco_1");
});

test("retorno do login e do cadastro só aceita caminho interno", () => {
  for (const ruim of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "", null, undefined]) {
    assert.equal(caminhoInternoSeguro(ruim as string | null | undefined), "/", String(ruim));
  }
  assert.equal(caminhoInternoSeguro("/planos?plano=plus"), "/planos?plano=plus");
});

test("plano escolhido na TV: só id bem formado", () => {
  assert.equal(planoEscolhidoDaUrl("?plano=plus"), "plus");
  assert.equal(planoEscolhidoDaUrl("?plano=premium&x=1"), "premium");
  assert.equal(planoEscolhidoDaUrl("?plano=<script>"), null);
  assert.equal(planoEscolhidoDaUrl(""), null);
});
