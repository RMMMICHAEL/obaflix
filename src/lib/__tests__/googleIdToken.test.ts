import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verificarIdTokenGoogle } from "../googleIdToken";

const par = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const outra = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...par.publicKey.export({ format: "jwk" }), kid: "k1" };
const AUD = "web-client.apps.googleusercontent.com";
const NONCE = "n".repeat(43);
const AGORA = 1_800_000_000;

function token(payload: Record<string, unknown>, chave = par.privateKey, kid = "k1", alg = "RS256") {
  const cab = Buffer.from(JSON.stringify({ alg, kid })).toString("base64url");
  const corpo = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${cab}.${corpo}`), chave).toString("base64url");
  return `${cab}.${corpo}.${sig}`;
}
const valido = { iss: "https://accounts.google.com", aud: AUD, exp: AGORA + 600, iat: AGORA - 5, nonce: NONCE, sub: "123456789012345", email: "a@b.com", email_verified: true, name: "A" };
const opts = (extra = {}) => ({ audiencias: [AUD], nonce: NONCE, chaves: async () => [jwk], agoraSeg: AGORA, ...extra });

test("token válido devolve o perfil; nada vem do cliente", async () => {
  const p = await verificarIdTokenGoogle(token(valido), opts());
  assert.deepEqual([p?.sub, p?.email, p?.emailVerificado, p?.dominioGerenciado], ["123456789012345", "a@b.com", true, false]);
});

test("recusa: assinatura de outra chave, alg diferente, kid desconhecido, token adulterado", async () => {
  assert.equal(await verificarIdTokenGoogle(token(valido, outra.privateKey), opts()), null);
  assert.equal(await verificarIdTokenGoogle(token(valido, par.privateKey, "k1", "none"), opts()), null);
  assert.equal(await verificarIdTokenGoogle(token(valido, par.privateKey, "desconhecido"), opts()), null);
  const [c, , s] = token(valido).split(".");
  const adulterado = `${c}.${Buffer.from(JSON.stringify({ ...valido, email: "x@y.com" })).toString("base64url")}.${s}`;
  assert.equal(await verificarIdTokenGoogle(adulterado, opts()), null);
});

test("recusa: emissor, público, expirado, nonce de outra tentativa, sem sub/e-mail", async () => {
  for (const mudanca of [{ iss: "https://evil.example" }, { aud: "outro-client" }, { exp: AGORA - 1 }, { nonce: "x".repeat(43) }, { sub: undefined }, { email: undefined }, { iat: AGORA + 3600 }]) {
    assert.equal(await verificarIdTokenGoogle(token({ ...valido, ...mudanca }), opts()), null, JSON.stringify(mudanca));
  }
});

test("e-mail não verificado chega ao resolvedor como não verificado (ele recusa); kid novo busca as chaves de novo", async () => {
  const p = await verificarIdTokenGoogle(token({ ...valido, email_verified: false }), opts());
  assert.equal(p?.emailVerificado, false);
  let buscas = 0;
  const q = await verificarIdTokenGoogle(token(valido), opts({ chaves: async (r: boolean) => { buscas++; return r ? [jwk] : []; } }));
  assert.equal(q?.sub, "123456789012345");
  assert.equal(buscas, 2);
});
