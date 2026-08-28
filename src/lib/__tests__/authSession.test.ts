// Testes da normalização do token — a parte pura do ponto único de autorização.
// Sem rede, sem NextAuth: `getToken` já é código de terceiros testado, o que
// precisa de rede de proteção aqui é a regra que separa as duas entradas.
// Rodar com: npm run test:web

import test from "node:test";
import assert from "node:assert/strict";

import { normalizarToken } from "../authSession";

const SESSAO_WEB = { id: "user_abc", role: "user" };
const SESSAO_TV = { id: "user_abc", role: "user", tv: true, did: "dev_1" };

// ── Entrada por cookie (site, Electron, app móvel) ───────────────────────────

test("cookie válido devolve o usuário sem aparelho", () => {
  const u = normalizarToken(SESSAO_WEB, "cookie");
  assert.deepEqual(u, {
    userId: "user_abc",
    role: "user",
    origem: "cookie",
    deviceId: null,
  });
});

test("cookie sem id não autentica", () => {
  assert.equal(normalizarToken({ role: "admin" }, "cookie"), null);
});

test("token ausente não autentica", () => {
  assert.equal(normalizarToken(null, "cookie"), null);
  assert.equal(normalizarToken(null, "bearer"), null);
});

test("papel ausente cai para 'user', nunca para admin", () => {
  assert.equal(normalizarToken({ id: "u1" }, "cookie")?.role, "user");
  assert.equal(normalizarToken({ id: "u1", role: "" }, "cookie")?.role, "user");
});

// ── Entrada por Bearer (TV) ─────────────────────────────────────────────────

test("bearer de TV devolve o aparelho de origem", () => {
  const u = normalizarToken(SESSAO_TV, "bearer");
  assert.deepEqual(u, {
    userId: "user_abc",
    role: "user",
    origem: "bearer",
    deviceId: "dev_1",
  });
});

// Este é o caso que justifica a claim `tv`. Sem ele, um cookie de sessão do
// navegador reenviado no header Authorization viraria credencial de TV — e uma
// credencial sem aparelho não pode ser revogada isoladamente.
test("cookie de sessão do site reenviado como Bearer é recusado", () => {
  assert.equal(normalizarToken(SESSAO_WEB, "bearer"), null);
});

test("bearer sem aparelho é recusado", () => {
  assert.equal(normalizarToken({ id: "u1", role: "user", tv: true }, "bearer"), null);
  assert.equal(
    normalizarToken({ id: "u1", role: "user", tv: true, did: "" }, "bearer"),
    null,
  );
});

test("claim tv só vale como booleano verdadeiro", () => {
  // "true" em texto é o que chegaria de um token forjado a partir de querystring.
  assert.equal(
    normalizarToken({ id: "u1", role: "user", tv: "true", did: "dev_1" }, "bearer"),
    null,
  );
  assert.equal(
    normalizarToken({ id: "u1", role: "user", tv: 1, did: "dev_1" }, "bearer"),
    null,
  );
});

// ── Papel ───────────────────────────────────────────────────────────────────

test("papel de admin atravessa, mas é só declaração do token", () => {
  // A rota que decide acesso administrativo reconfirma no banco — ver o
  // comentário em authSession.ts e o que /api/player/fontes já faz.
  assert.equal(normalizarToken({ id: "u1", role: "admin" }, "cookie")?.role, "admin");
});

test("papel não-texto não vira admin", () => {
  assert.equal(normalizarToken({ id: "u1", role: { admin: true } }, "cookie")?.role, "user");
});
