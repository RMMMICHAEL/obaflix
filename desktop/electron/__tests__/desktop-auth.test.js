"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  callbackInternoSeguro,
  createPkceFlow,
  findDeepLinkArg,
  parseDesktopAuthDeepLink,
  flowAindaValido,
} = require("../desktop-auth");

test("callback desktop aceita somente caminho interno", () => {
  assert.equal(callbackInternoSeguro("/checkout?planoId=plus"), "/checkout?planoId=plus");
  assert.equal(callbackInternoSeguro("//evil.example"), "/desktop");
  assert.equal(callbackInternoSeguro("/\\evil.example"), "/desktop");
  assert.equal(callbackInternoSeguro("https://evil.example"), "/desktop");
});

test("PKCE desktop gera verifier, challenge e state fortes", () => {
  const flow = createPkceFlow("/planos", 1000);
  assert.match(flow.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(flow.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(flow.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    flow.challenge,
    crypto.createHash("sha256").update(flow.verifier).digest("base64url"),
  );
  assert.equal(flow.callbackUrl, "/planos");
});

test("deep link aceita somente obaflix://auth/callback", () => {
  const state = "A".repeat(43);
  const good = `obaflix://auth/callback?ticket=abc.def&state=${state}`;
  assert.deepEqual(parseDesktopAuthDeepLink(good), { ticket: "abc.def", state });
  assert.equal(parseDesktopAuthDeepLink(`obaflix://other/callback?ticket=x&state=${state}`), null);
  assert.equal(parseDesktopAuthDeepLink(`https://auth/callback?ticket=x&state=${state}`), null);
  assert.equal(parseDesktopAuthDeepLink(`obaflix://auth/other?ticket=x&state=${state}`), null);
  assert.equal(findDeepLinkArg(["Obaflix.exe", "--flag", good]), good);
});

test("state precisa pertencer ao fluxo pendente e nao pode expirar", () => {
  const flow = createPkceFlow("/desktop", 10_000);
  assert.equal(flowAindaValido(flow, flow.state, 10_001), true);
  assert.equal(flowAindaValido(flow, "B".repeat(43), 10_001), false);
  assert.equal(flowAindaValido(flow, flow.state, 10_000 + 10 * 60 * 1000 + 1), false);
});

test("Direct Link desktop usa IPC restrito e exige retorno de foco", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  assert.match(main, /const SPONSORED_LINK_URL = "https:\/\/omg10\.com\/4\/11767843"/);
  assert.match(main, /rawUrl !== SPONSORED_LINK_URL/);
  assert.match(main, /janela\.on\("blur"/);
  assert.match(main, /janela\.on\("focus"/);
  assert.match(main, /await shell\.openExternal\(SPONSORED_LINK_URL\)/);
  assert.match(preload, /openSponsoredLink: \(url\) => ipcRenderer\.invoke\("open-sponsored-link", url\)/);
});
