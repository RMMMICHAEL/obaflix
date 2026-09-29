"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { criarGravador, resumir } = require("../monetag-diagnostico");

test("gravador guarda método, status, Origin/Referer e só a presença de cookie", () => {
  const g = criarGravador();
  g.envio({ id: 1, method: "POST", requestHeaders: { Origin: "null", "User-Agent": "UA", Cookie: "segredo=1" } });
  g.fim({ id: 1, url: "https://jhnwr.com/400/11917353?x=1", resourceType: "xhr", statusCode: 200 });
  const [c] = g.chamadas;
  assert.equal(c.metodo, "POST");
  assert.equal(c.status, 200);
  assert.equal(c.origin, "null");
  assert.equal(c.referer, "(ausente)");
  assert.equal(c.enviouCookie, true);
  assert.ok(!JSON.stringify(g.chamadas).includes("segredo"), "valor de cookie nunca é gravado");
});

test("resumo separa tag, chamadas POST da zona e seus status", () => {
  const g = criarGravador();
  const add = (id, method, url, statusCode) => { g.envio({ id, method, requestHeaders: {} }); g.fim({ id, url, resourceType: "xhr", statusCode }); };
  add(1, "GET", "https://nap5k.com/tag.min.js", 200);
  add(2, "POST", "https://jhnwr.com/400/11917353?oo=1", 200);
  add(3, "GET", "https://jhnwr.com/500/11917353?excludes=", 200);
  const r = resumir(g.chamadas, "11917353");
  assert.equal(r.tagMinJs, 200);
  assert.deepEqual(r.statusDaZona, [200]);
  assert.equal(r.chamadasDaZona.length, 1);
});

test("main.js só liga o diagnóstico com --diagnostico-monetag; janelas B sem preload", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /process\.argv\.includes\("--diagnostico-monetag"\)/);
  assert.match(main, /const diagnosticoMonetag = DIAGNOSTICO_MONETAG\s*\n?\s*\? require\("\.\/monetag-diagnostico"\)/);
  const diag = fs.readFileSync(path.join(__dirname, "..", "monetag-diagnostico.js"), "utf8");
  const prefs = /webPreferences: \{([\s\S]*?)\}/.exec(diag)[1];
  assert.ok(!/preload/.test(prefs.replace(/\/\/.*$/gm, "")), "janela B nunca recebe preload");
  assert.match(prefs, /sandbox: true/);
  assert.match(prefs, /contextIsolation: true/);
  assert.match(prefs, /nodeIntegration: false/);
  assert.match(diag, /session\.fromPartition\(`diag-monetag-/, "partição da janela B é em memória (sem persist:)");
  assert.match(diag, /setPermissionRequestHandler\(\(_wc, _p, cb\) => cb\(false\)\)/);
  assert.match(diag, /will-download", \(e\) => e\.preventDefault\(\)/);
});
