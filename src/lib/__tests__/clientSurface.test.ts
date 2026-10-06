import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { ehNavegadorComum } from "@/config/client-surface";

/**
 * Quem recebe o modal de download é só o navegador comum. Android (WebView) e
 * Electron (janela nativa) têm player e seguem pelo <Link>.
 *
 * Reproduz os globais que o navegador exporia; `ehNavegadorComum` os lê a cada
 * chamada, então basta trocá-los entre os casos.
 */

// `navigator` é um global somente-leitura no Node 22; redefinir com
// defineProperty (configurável) em vez de atribuir.
function definir(nome: string, valor: unknown) {
  Object.defineProperty(globalThis, nome, { value: valor, configurable: true, writable: true });
}

function definirAmbiente(opts: { ua?: string; obaflixDesktop?: unknown; android?: boolean }) {
  definir("window", {
    obaflixDesktop: opts.obaflixDesktop,
    __OBAFLIX_ANDROID__: opts.android === true ? true : undefined,
    sessionStorage: { getItem: () => null },
  });
  definir("navigator", {
    userAgent: opts.ua ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120",
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "navigator");
});

test("navegador comum: intercepta (true)", () => {
  definirAmbiente({});
  assert.equal(ehNavegadorComum("/filme/abc"), true);
});

test("Android (UA ObaflixApp): não intercepta", () => {
  definirAmbiente({ ua: "Mozilla/5.0 ObaflixApp/1.0.10" });
  assert.equal(ehNavegadorComum("/filme/abc"), false);
});

test("Android (rota /android): não intercepta", () => {
  definirAmbiente({});
  assert.equal(ehNavegadorComum("/android/filme/abc"), false);
});

test("Electron (ponte obaflixDesktop.isDesktop): não intercepta", () => {
  definirAmbiente({ obaflixDesktop: { isDesktop: true, platform: "win32" } });
  assert.equal(ehNavegadorComum("/filme/abc"), false);
});

test("Electron (UA ObaflixDesktop): não intercepta", () => {
  definirAmbiente({ ua: "Mozilla/5.0 ObaflixDesktop/1.0.12" });
  assert.equal(ehNavegadorComum("/filme/abc"), false);
});
