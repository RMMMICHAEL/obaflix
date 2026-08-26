// Testes da rotulagem e da disponibilidade das fontes do webcine.
// Lógica pura, sem rede. Rodar com: npm run test:web
//
// Por que existem: `locked` é relativo à conta. A conta usada nos testes tem
// assinatura e VIP, então varrer o catálogo (65+ títulos, 141 chamadas) não
// produziu uma única fonte bloqueada. Estes casos cobrem o que a matriz real
// não consegue exercitar — ver scripts/achar-casos-webcine.ts.

import test from "node:test";
import assert from "node:assert/strict";

import { rotularFontes } from "../cinevs";

const ACESSO_TOTAL = { temAssinatura: true, temVip: true };

const video = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  audio_type: "dubbed",
  is_premium: false,
  is_code: false,
  locked: false,
  sort_order: 0,
  ...extra,
});

// ── Rótulos ─────────────────────────────────────────────────────────────────

test("duas fontes com o mesmo áudio viram Dublado e Dublado 2", () => {
  // Medido: os quatro primeiros títulos testados tinham duas fontes "dubbed".
  const f = rotularFontes(
    [video({ id: 10, sort_order: 0 }), video({ id: 11, sort_order: 1 })],
    ACESSO_TOTAL,
  );
  assert.deepEqual(f.map((x) => x.label), ["Dublado", "Dublado 2"]);
  assert.deepEqual(f.map((x) => x.videoId), [10, 11]);
});

test("premium ganha sufixo próprio em vez de número", () => {
  const f = rotularFontes(
    [video({ id: 10 }), video({ id: 11, is_premium: true, sort_order: 1 })],
    ACESSO_TOTAL,
  );
  assert.deepEqual(f.map((x) => x.label), ["Dublado", "Dublado Premium"]);
});

test("subtitled vira Legendado", () => {
  const f = rotularFontes([video({ audio_type: "subtitled" })], ACESSO_TOTAL);
  assert.equal(f[0].label, "Legendado");
});

test("áudio desconhecido não quebra o rótulo", () => {
  const f = rotularFontes([video({ audio_type: "cantonese" })], ACESSO_TOTAL);
  assert.equal(f[0].label, "Cantonese");
});

test("a ordem segue sort_order, não a ordem do array", () => {
  const f = rotularFontes(
    [video({ id: 20, sort_order: 5 }), video({ id: 21, sort_order: 1 })],
    ACESSO_TOTAL,
  );
  assert.deepEqual(f.map((x) => x.videoId), [21, 20]);
});

test("video id é preservado como identificador estável", () => {
  // audio_type se repete; só o id distingue as fontes.
  const f = rotularFontes(
    [video({ id: 581612 }), video({ id: 581856, is_premium: true, sort_order: 1 })],
    ACESSO_TOTAL,
  );
  assert.deepEqual(f.map((x) => x.videoId), [581612, 581856]);
  assert.equal(new Set(f.map((x) => x.videoId)).size, 2);
});

// ── Disponibilidade — nunca contornamos restrição ───────────────────────────

test("locked marca a fonte como indisponível", () => {
  const f = rotularFontes([video({ locked: true })], ACESSO_TOTAL);
  assert.equal(f[0].disponivel, false);
  assert.match(f[0].motivoIndisponivel ?? "", /bloqueado/i);
});

test("premium sem VIP é indisponível", () => {
  const f = rotularFontes([video({ is_premium: true })], { temAssinatura: true, temVip: false });
  assert.equal(f[0].disponivel, false);
  assert.match(f[0].motivoIndisponivel ?? "", /VIP/i);
});

test("premium COM VIP é disponível", () => {
  const f = rotularFontes([video({ is_premium: true })], ACESSO_TOTAL);
  assert.equal(f[0].disponivel, true);
});

test("is_code exige desbloqueio e fica indisponível", () => {
  const f = rotularFontes([video({ is_code: true })], ACESSO_TOTAL);
  assert.equal(f[0].disponivel, false);
  assert.match(f[0].motivoIndisponivel ?? "", /código/i);
});

test("sem assinatura, nada fica disponível", () => {
  const f = rotularFontes([video(), video({ id: 2, sort_order: 1 })], { temAssinatura: false, temVip: false });
  assert.deepEqual(f.map((x) => x.disponivel), [false, false]);
});

test("locked vence os outros motivos", () => {
  // Quando várias restrições valem, a mensagem tem que ser a mais específica.
  const f = rotularFontes([video({ locked: true, is_premium: true, is_code: true })], {
    temAssinatura: false, temVip: false,
  });
  assert.match(f[0].motivoIndisponivel ?? "", /bloqueado/i);
});

test("fonte indisponível continua listada, com todos os metadados", () => {
  // Ela aparece no menu como indisponível — não some, e não é tentada.
  const f = rotularFontes([video({ id: 99, locked: true, is_premium: true, sort_order: 3 })], ACESSO_TOTAL);
  assert.equal(f.length, 1);
  assert.equal(f[0].videoId, 99);
  assert.equal(f[0].isPremium, true);
  assert.equal(f[0].locked, true);
  assert.equal(f[0].sortOrder, 3);
  assert.equal(f[0].audioType, "dubbed");
});
