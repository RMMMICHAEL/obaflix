import assert from "node:assert/strict";
import test from "node:test";
import { consumirIntencaoVinculo, criarIntencaoVinculo, lerIntencaoVinculo, TTL_VINCULO_GOOGLE_SEG } from "../googleLink";

const SEGREDO = "s".repeat(40);

test("a autorização de vínculo é presa à conta, expira em 5 minutos e não aceita adulteração nem outro segredo", () => {
  const agora = Date.now();
  const t = criarIntencaoVinculo("u1", SEGREDO, agora);
  assert.equal(lerIntencaoVinculo(t, SEGREDO, agora + 1000)?.uid, "u1");
  assert.equal(lerIntencaoVinculo(t, SEGREDO, agora + (TTL_VINCULO_GOOGLE_SEG - 1) * 1000)?.uid, "u1");
  assert.equal(lerIntencaoVinculo(t, SEGREDO, agora + (TTL_VINCULO_GOOGLE_SEG + 2) * 1000), null); // expirada
  assert.equal(lerIntencaoVinculo(t, "x".repeat(40), agora), null); // outro segredo
  const [corpo, assin] = t.split(".");
  const outro = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(corpo, "base64url").toString()), uid: "u2" })).toString("base64url");
  assert.equal(lerIntencaoVinculo(`${outro}.${assin}`, SEGREDO, agora), null); // trocar a conta quebra a assinatura
  assert.equal(lerIntencaoVinculo("lixo", SEGREDO, agora), null);
  assert.equal(lerIntencaoVinculo(`${t}.extra`, SEGREDO, agora), null);
});

test("a autorização é de uso único e falha fechada sem Redis", async () => {
  const usados = new Set<string>();
  const redis = { async set(k: string, _v: string, o: { ex: number; nx: boolean }) { assert.ok(o.nx); if (usados.has(k)) return null; usados.add(k); return "OK" as const; } };
  const t = lerIntencaoVinculo(criarIntencaoVinculo("u1", SEGREDO), SEGREDO)!;
  assert.equal(await consumirIntencaoVinculo(redis, t.jti), true);
  assert.equal(await consumirIntencaoVinculo(redis, t.jti), false); // replay
  assert.equal(await consumirIntencaoVinculo({ async set() { throw new Error("fora"); } } as never, "outra"), false);
});

test("segredo curto ou usuário vazio não emitem autorização", () => {
  assert.throws(() => criarIntencaoVinculo("u1", "curto"));
  assert.throws(() => criarIntencaoVinculo("", SEGREDO));
});
