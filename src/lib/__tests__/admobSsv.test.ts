import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { processarSsvDoAdMob } from "../ads/admobSsv";
import { escolherProvedores } from "../ads/provedor";
import { identidadeDoLevelPlay, prepararRecompensa, reciboDoDesafio, type ArmazemDeRecompensa } from "../ads/recompensaLevelPlay";

/**
 * Receptor SSV do AdMob. O par de chaves é gerado aqui (ECDSA P-256, como as do Google): nenhuma chave real existe
 * neste arquivo. Armazém em memória.
 */
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = publicKey.export({ type: "spki", format: "pem" }) as string;
const OUTRA = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY_ID = "3335741209";
const AGORA = Date.UTC(2026, 10, 5, 12, 0);
const ENV = { ADMOB_SSV_ATIVO: "true" };
const chaves = async () => ({ [KEY_ID]: PEM });

function memoria(): ArmazemDeRecompensa {
  const d = new Map<string, string>();
  return {
    get: async (k) => d.get(k) ?? null,
    set: async (k, v, o) => { if (o?.nx && d.has(k)) return null; d.set(k, v); return "OK"; },
    del: async (k) => (d.delete(k) ? 1 : 0),
  };
}

/** Query no formato do AdMob: parâmetros, depois `signature` e `key_id` por último. */
function ssv(parametros: Record<string, string>, opcoes: { chave?: crypto.KeyObject; keyId?: string } = {}): string {
  return assinar(new URLSearchParams(parametros).toString(), opcoes);
}

function assinar(base: string, opcoes: { chave?: crypto.KeyObject; keyId?: string } = {}): string {
  const sig = crypto.createSign("SHA256").update(base).sign(opcoes.chave ?? privateKey).toString("base64url");
  return `${base}&signature=${sig}&key_id=${opcoes.keyId ?? KEY_ID}`;
}

async function conta(s: ArmazemDeRecompensa, userId = "u1", desafioId = "d1") {
  const lpUid = await identidadeDoLevelPlay(userId, s);
  const { dynamicUserId } = await prepararRecompensa({ userId, desafioId }, s);
  return { lpUid, dynamicUserId, desafioId };
}

const params = (c: { lpUid: string; dynamicUserId: string }, sobre: Record<string, string> = {}) => ({
  ad_network: "5450213213286189855", ad_unit: "6440175364", reward_amount: "1", reward_item: "x",
  timestamp: String(AGORA), transaction_id: "ABCDEF0123456789", user_id: c.lpUid, custom_data: c.dynamicUserId, ...sobre,
});

const receber = (s: ArmazemDeRecompensa, q: string, extra: { env?: Record<string, string | undefined>; agora?: number } = {}) =>
  processarSsvDoAdMob({ queryBruta: q, agora: extra.agora ?? AGORA, env: extra.env ?? ENV, chaves }, s);

describe("SSV do AdMob", () => {
  test("evento legítimo: grava o recibo do desafio e reconhece", async () => {
    const s = memoria();
    const c = await conta(s);
    const r = await receber(s, ssv(params(c)));
    assert.equal(r.status, 200);
    assert.equal(r.ack, true);
    assert.deepEqual(await reciboDoDesafio(c.desafioId, s), { eventId: "admobABCDEF0123456789" });
  });

  test("reentrega do mesmo evento: reconhece sem novo recibo", async () => {
    const s = memoria();
    const c = await conta(s);
    await receber(s, ssv(params(c)));
    const r = await receber(s, ssv(params(c)));
    assert.equal(r.status, 200);
    assert.equal(r.ack, true);
  });

  test("desligado: 404 e nada gravado", async () => {
    const s = memoria();
    const c = await conta(s);
    assert.equal((await receber(s, ssv(params(c)), { env: {} })).status, 404);
    assert.equal(await reciboDoDesafio(c.desafioId, s), null);
  });

  test("assinatura de outra chave, key_id desconhecido ou conteúdo alterado: recusa sem recibo", async () => {
    const s = memoria();
    const c = await conta(s);
    const p = params(c);
    assert.equal((await receber(s, ssv(p, { chave: OUTRA.privateKey }))).status, 403);
    assert.equal((await receber(s, ssv(p, { keyId: "999" }))).status, 403);
    const q = ssv(p);
    assert.equal((await receber(s, q.replace("reward_amount=1", "reward_amount=9"))).status, 403);
    assert.equal(await reciboDoDesafio(c.desafioId, s), null);
  });

  test("sem assinatura ou key_id: 400", async () => {
    const s = memoria();
    const c = await conta(s);
    const base = new URLSearchParams(params(c)).toString();
    assert.equal((await receber(s, base)).status, 400);
    assert.equal((await receber(s, `${base}&signature=abc`)).status, 400);
  });

  test("ad unit fora da lista, parâmetros malformados ou duplicados e timestamp velho: recusa", async () => {
    const s = memoria();
    const c = await conta(s);
    assert.equal((await receber(s, ssv(params(c, { ad_unit: "1111111111" })))).status, 403);
    assert.equal((await receber(s, ssv(params(c, { custom_data: "zz" })))).status, 400);
    assert.equal((await receber(s, ssv(params(c, { user_id: "ABC" })))).status, 400);
    assert.equal((await receber(s, ssv(params(c, { transaction_id: "a-b" })))).status, 400);
    const duplicado = `${new URLSearchParams(params(c)).toString()}&custom_data=${c.dynamicUserId}`;
    assert.equal((await receber(s, assinar(duplicado))).status, 400);
    assert.equal((await receber(s, ssv(params(c, { timestamp: String(AGORA - 30 * 3600 * 1000) })))).status, 400);
    assert.equal(await reciboDoDesafio(c.desafioId, s), null);
  });

  test("assinatura válida sem desafio correspondente: reconhece (200) mas não grava recibo", async () => {
    const s = memoria();
    const c = await conta(s);
    const r = await receber(s, ssv(params({ lpUid: c.lpUid, dynamicUserId: "0".repeat(48) })));
    assert.equal(r.status, 200);
    assert.equal(r.ack, false);
    assert.equal(await reciboDoDesafio(c.desafioId, s), null);
    const desconhecida = await receber(s, ssv(params({ lpUid: "a".repeat(32), dynamicUserId: c.dynamicUserId })));
    assert.equal(desconhecida.ack, false);
    assert.equal(await reciboDoDesafio(c.desafioId, s), null);
  });

  test("evento de outra conta não paga esta", async () => {
    const s = memoria();
    const a = await conta(s, "a", "da");
    const b = await conta(s, "b", "db");
    await receber(s, ssv(params({ lpUid: b.lpUid, dynamicUserId: a.dynamicUserId })));
    assert.equal(await reciboDoDesafio("da", s), null);
    assert.equal(await reciboDoDesafio("db", s), null);
  });

  test("falha de armazenamento: 503 sem ACK (o Google repete)", async () => {
    const s = memoria();
    const c = await conta(s);
    const quebrado: ArmazemDeRecompensa = { ...s, set: async () => { throw new Error("redis fora"); } };
    const r = await receber(quebrado, ssv(params(c)));
    assert.equal(r.status, 503);
    assert.equal(r.ack, false);
  });

  test("lista de chaves fora do ar: 503", async () => {
    const s = memoria();
    const c = await conta(s);
    const r = await processarSsvDoAdMob({ queryBruta: ssv(params(c)), agora: AGORA, env: ENV, chaves: async () => { throw new Error("rede"); } }, s);
    assert.equal(r.status, 503);
  });
});

describe("escolha de provedor", () => {
  test("padrão: Unity e LevelPlay, qualquer valor diferente de admob também", () => {
    assert.deepEqual(escolherProvedores({}), { interstitial: "unity", rewarded: "levelplay" });
    assert.deepEqual(escolherProvedores({ ANUNCIO_PROVEDOR_INTERSTITIAL: "ADMOB", ANUNCIO_PROVEDOR_REWARDED: "true" }), { interstitial: "unity", rewarded: "levelplay" });
  });
  test("Interstitial do AdMob liga sozinho; Rewarded do AdMob só com o SSV ligado", () => {
    assert.deepEqual(escolherProvedores({ ANUNCIO_PROVEDOR_INTERSTITIAL: "admob" }), { interstitial: "admob", rewarded: "levelplay" });
    assert.equal(escolherProvedores({ ANUNCIO_PROVEDOR_REWARDED: "admob" }).rewarded, "levelplay");
    assert.equal(escolherProvedores({ ANUNCIO_PROVEDOR_REWARDED: "admob", ADMOB_SSV_ATIVO: "true" }).rewarded, "admob");
  });
});
