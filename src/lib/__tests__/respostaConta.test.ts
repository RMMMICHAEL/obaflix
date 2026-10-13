// Regressão do "Application error" da página /conta após exclusão de conta.
// Rodar com: npm run test:web
//
// O bug: `/api/user/watchlist` respondia 401 (sessão revogada) ou 429 (limite)
// com um OBJETO `{ error: "..." }`; a página fazia `r.json()` sem checar `r.ok`,
// jogava o objeto em `setWatchlist`, e o render quebrava em `watchlist.map`.
// Estes testes exercitam a classificação real que a página agora usa.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { classificarLista, classificarPlano, sessaoRevogada } from "../conta/respostaConta";

/** Response-like mínimo. `json` pode lançar para simular corpo inválido. */
const resp = (status: number, body: unknown, { jsonThrows = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (jsonThrows) throw new SyntaxError("Unexpected token < in JSON");
    return body;
  },
});

describe("classificarLista: watchlist/histórico nunca quebram o render", () => {
  test("401 com corpo OBJETO (o bug real) → revogada, nunca vira a lista", async () => {
    const r = resp(401, { error: "Não autenticado" });
    assert.deepEqual(await classificarLista(r), { tipo: "revogada" });
  });

  test("200 com array → ok com os dados", async () => {
    const dados = [{ conteudoId: "f1" }, { conteudoId: "s2" }];
    assert.deepEqual(await classificarLista(resp(200, dados)), { tipo: "ok", dados });
  });

  test("200 com array vazio → ok vazio (lista válida, não revogada)", async () => {
    assert.deepEqual(await classificarLista(resp(200, [])), { tipo: "ok", dados: [] });
  });

  test("429 (limite) com corpo objeto → vazio, nunca o objeto de erro", async () => {
    assert.deepEqual(await classificarLista(resp(429, { error: "Muitas solicitações" })), { tipo: "vazio" });
  });

  test("500 → vazio", async () => {
    assert.deepEqual(await classificarLista(resp(500, { error: "x" })), { tipo: "vazio" });
  });

  test("200 com JSON que NÃO é array (objeto inesperado) → vazio", async () => {
    assert.deepEqual(await classificarLista(resp(200, { error: "formato errado" })), { tipo: "vazio" });
  });

  test("200 com JSON inválido (json() lança) → vazio", async () => {
    assert.deepEqual(await classificarLista(resp(200, null, { jsonThrows: true })), { tipo: "vazio" });
  });

  test("o resultado de lista nunca é algo sem .map quando usado como lista", async () => {
    for (const r of [resp(429, { error: "x" }), resp(500, {}), resp(200, { nope: 1 }), resp(200, null, { jsonThrows: true })]) {
      const res = await classificarLista(r);
      const lista = res.tipo === "ok" ? res.dados : [];
      assert.ok(Array.isArray(lista), "sempre um array seguro para .map");
    }
  });
});

describe("classificarPlano: /api/billing/me", () => {
  test("401 → revogada (encerra sessão, igual às listas)", async () => {
    assert.deepEqual(await classificarPlano(resp(401, { error: "x" })), { tipo: "revogada" });
  });

  test("200 com objeto de plano → ok", async () => {
    const dados = { plano: { id: "p1", nome: "Premium" }, assinatura: null };
    assert.deepEqual(await classificarPlano(resp(200, dados)), { tipo: "ok", dados });
  });

  test("não-OK (não-401) → vazio (null no plano, mostra 'Carregando…')", async () => {
    assert.deepEqual(await classificarPlano(resp(503, { error: "x" })), { tipo: "vazio" });
  });

  test("200 com array (formato errado) → vazio", async () => {
    assert.deepEqual(await classificarPlano(resp(200, [])), { tipo: "vazio" });
  });

  test("200 com JSON inválido → vazio", async () => {
    assert.deepEqual(await classificarPlano(resp(200, null, { jsonThrows: true })), { tipo: "vazio" });
  });
});

describe("sessaoRevogada: só 401 sinaliza revogação", () => {
  test("401 é revogada; 200/429/500 não", () => {
    assert.equal(sessaoRevogada(401), true);
    for (const s of [200, 204, 429, 500, 503, 403]) assert.equal(sessaoRevogada(s), false, `status ${s}`);
  });
});
