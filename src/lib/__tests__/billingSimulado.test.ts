import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import {
  confirmadorDeCobranca,
  criarConfirmadorSimulado,
  criarProvedorSimulado,
  definirStatusSimulado,
  provedorDeCobranca,
  simulacaoDePagamentoAtiva,
} from "../billing/simulado";
import { POST as pagamentoSimuladoPost } from "../../app/api/teste/pagamento-simulado/route";

/**
 * Pagamento simulado do ambiente isolado. Não valida a Blackcat — só garante que
 * a simulação não liga fora do lugar e que muda estado só por onde deve.
 */

const TESTE = { PAGAMENTO_SIMULADO: "true", OBAFLIX_AMBIENTE: "teste", VERCEL_ENV: "preview" };
const TOKEN = "t".repeat(40);

function redisEmMemoria() {
  const dados = new Map<string, string>();
  return { dados, get: async (k: string) => dados.get(k) ?? null, set: async (k: string, v: string) => { dados.set(k, v); return "OK"; } };
}

describe("quando a simulação liga", () => {
  test("só com as três condições juntas", () => {
    assert.equal(simulacaoDePagamentoAtiva(TESTE), true);
    assert.equal(simulacaoDePagamentoAtiva({ ...TESTE, VERCEL_ENV: "production" }), false, "nunca em Production");
    assert.equal(simulacaoDePagamentoAtiva({ ...TESTE, OBAFLIX_AMBIENTE: "producao" }), false);
    assert.equal(simulacaoDePagamentoAtiva({ ...TESTE, PAGAMENTO_SIMULADO: "TRUE" }), false);
    assert.equal(simulacaoDePagamentoAtiva({}), false);
  });

  test("fora do ambiente de teste, pedido e confirmação usam a Blackcat (sem chave, nada)", () => {
    const real = provedorDeCobranca({ VERCEL_ENV: "production", PAGAMENTO_SIMULADO: "true", OBAFLIX_AMBIENTE: "teste" });
    assert.equal(real.nome, "blackcat");
    assert.equal(real.provedor, null, "sem BLACKCAT_API_KEY não há provedor");
    assert.equal(confirmadorDeCobranca({ VERCEL_ENV: "production" }), null);
  });

  test("Production recusa 'simulado' no banco: CHECK original só com blackcat", () => {
    const original = readFileSync("prisma/migrations/20260910_pedido_pagamento/migration.sql", "utf8");
    assert.ok(original.includes(`CHECK ("provedor" IN ('blackcat'))`));
    const soTeste = readFileSync("scripts/ambiente-teste/03-provedor-simulado-somente-teste.sql", "utf8");
    assert.ok(soTeste.indexOf("_ObaflixAmbiente") < soTeste.indexOf("ALTER TABLE"), "marcador conferido antes de alterar");
  });
});

describe("fluxo simulado", () => {
  test("venda nasce PENDING, não pagável; muda só pelo operador; confirmação lê o estado", async () => {
    const redis = redisEmMemoria();
    const agora = new Date("2026-09-14T12:00:00.000Z");
    const r = await criarProvedorSimulado(redis, () => agora).criarVenda({ refExterna: "r", valorCentavos: 1990, moeda: "BRL", descricao: "Plus", pagador: {} as any });
    assert.ok(r.ok);
    assert.match(r.venda.transacaoId, /^sim_[a-f0-9]{24}$/);
    assert.equal(r.venda.copiaECola.includes("NAO-PAGAVEL"), true);

    const confirmar = criarConfirmadorSimulado(redis);
    assert.equal((await confirmar(r.venda.transacaoId)).ok && (await confirmar(r.venda.transacaoId) as any).confirmacao.status, "PENDING");

    assert.equal(await definirStatusSimulado(redis, r.venda.transacaoId, "PAID", undefined, agora), true);
    const pago = await confirmar(r.venda.transacaoId);
    assert.ok(pago.ok);
    assert.deepEqual([pago.confirmacao.status, pago.confirmacao.amount, pago.confirmacao.paidAt?.toISOString()], ["PAID", 1990, agora.toISOString()]);

    assert.equal(await definirStatusSimulado(redis, "sim_" + "0".repeat(24), "PAID", undefined, agora), false, "não cria venda que não existe");
    assert.deepEqual(await confirmar("sim_" + "0".repeat(24)), { ok: false, falha: "nao_encontrada" });
  });
});

describe("rota de teste", () => {
  const post = (body: object, token?: string) =>
    new NextRequest("http://local/api/teste/pagamento-simulado", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-teste-token": token } : {}) },
      body: JSON.stringify(body),
    });

  test("404 fora do ambiente de teste, mesmo com token", async () => {
    const h = pagamentoSimuladoPost.createForTest({ env: { ...TESTE, VERCEL_ENV: "production", TESTE_PAGAMENTO_TOKEN: TOKEN }, redis: redisEmMemoria() });
    assert.equal((await h(post({ transacaoId: "sim_" + "a".repeat(24), status: "PAID" }, TOKEN))).status, 404);
  });

  test("404 sem token, com token errado ou com token curto configurado", async () => {
    const redis = redisEmMemoria();
    const h = pagamentoSimuladoPost.createForTest({ env: { ...TESTE, TESTE_PAGAMENTO_TOKEN: TOKEN }, redis });
    assert.equal((await h(post({ transacaoId: "sim_" + "a".repeat(24), status: "PAID" }))).status, 404);
    assert.equal((await h(post({ transacaoId: "sim_" + "a".repeat(24), status: "PAID" }, "x".repeat(40)))).status, 404);
    const curto = pagamentoSimuladoPost.createForTest({ env: { ...TESTE, TESTE_PAGAMENTO_TOKEN: "curto" }, redis });
    assert.equal((await curto(post({ transacaoId: "sim_" + "a".repeat(24), status: "PAID" }, "curto"))).status, 404);
  });

  test("com ambiente e token: muda o estado de venda existente, recusa status desconhecido", async () => {
    const redis = redisEmMemoria();
    const venda = await criarProvedorSimulado(redis).criarVenda({ refExterna: "r", valorCentavos: 1000, moeda: "BRL", descricao: "B", pagador: {} as any });
    assert.ok(venda.ok);
    const h = pagamentoSimuladoPost.createForTest({ env: { ...TESTE, TESTE_PAGAMENTO_TOKEN: TOKEN }, redis });
    assert.equal((await h(post({ transacaoId: venda.venda.transacaoId, status: "APROVADO" }, TOKEN))).status, 400);
    assert.equal((await h(post({ transacaoId: venda.venda.transacaoId, status: "REFUNDED" }, TOKEN))).status, 200);
    const c = await criarConfirmadorSimulado(redis)(venda.venda.transacaoId);
    assert.ok(c.ok);
    assert.equal(c.confirmacao.status, "REFUNDED");
  });
});
