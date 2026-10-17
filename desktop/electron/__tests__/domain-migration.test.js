"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const politica = require("../window-policy");
const root = path.resolve(__dirname, "../../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const APP = "https://obaflixbr.com";

test("Electron: entrada e extratores usam o novo dominio e respeitam override", () => {
  for (const [file, variable] of [
    ["main.js", "OBAFLIX_URL"],
    ["extractors.js", "OBAFLIX_URL"],
    ["browser-extractor.js", "APP_URL"],
  ]) {
    // Avalia a declaracao real sem iniciar Electron, rede ou auto-update.
    const source = read(`desktop/electron/${file}`);
    const declaration = source.match(new RegExp(`const ${variable} =[^;]+;`))?.[0];
    assert.ok(declaration, file);
    for (const override of [undefined, "https://homologacao.example", "http://localhost:3000"]) {
      const actual = vm.runInNewContext(`${declaration}\n${variable}`, {
        process: { env: { OBAFLIX_URL: override } },
      });
      assert.equal(actual, override || APP, file);
    }
  }
});

test("Referer de fallback acompanha dominio e override sem barra duplicada", () => {
  const declaration = read("desktop/electron/superflix-extractor.js")
    .match(/const appReferer =[^;]+;/)?.[0];
  assert.ok(declaration);
  for (const override of [undefined, "https://homologacao.example/"]) {
    const actual = vm.runInNewContext(`${declaration}\nappReferer`, {
      process: { env: { OBAFLIX_URL: override } }, options: {},
    });
    assert.equal(actual, override || APP + "/");
  }
  assert.equal(vm.runInNewContext(`${declaration}\nappReferer`, {
    process: { env: {} }, options: { appReferer: "https://referer.example/" },
  }), "https://referer.example/");
});

test("Android: app, TV e core compartilham o novo padrao; homologacao continua isolada", () => {
  assert.match(read("android/gradle.properties"), /^obaflix\.url=https:\/\/obaflixbr\.com$/m);
  for (const module of ["app", "tv", "core-extractor"]) {
    assert.match(read(`android/${module}/build.gradle`), /project\.property\('obaflix\.url'\)/, module);
  }
  for (const module of ["tv", "core-extractor"]) {
    const gradle = read(`android/${module}/build.gradle`);
    assert.ok(gradle.includes("contains('obaflixbr.com')"), module);
    assert.ok(gradle.includes("contains('obaflix.online')"), module);
    assert.ok(gradle.includes("findProperty('obaflix.urlTeste')"), module);
  }
});

test("IPC e navegacao: novo dominio aceito, antigos e imitacoes recusados", () => {
  for (const url of [APP + "/desktop", APP + "/login"]) {
    assert.equal(politica.ehDoApp(url, APP), true);
    assert.equal(politica.ipcConfiavel({ remetenteEhJanelaPrincipal: true,
      ehFramePrincipal: true, urlDoFrame: url, appOrigin: APP }), true);
  }
  for (const url of ["https://obaflix.online", "https://obaflix.vercel.app",
    "https://obaflixbr.com.evil.test", "https://obaflixbr.com@evil.test", "http://obaflixbr.com"]) {
    assert.equal(politica.ehDoApp(url, APP), false, url);
    assert.equal(politica.ipcConfiavel({ remetenteEhJanelaPrincipal: true,
      ehFramePrincipal: true, urlDoFrame: url, appOrigin: APP }), false, url);
  }
  assert.equal(politica.ipcConfiavel({ remetenteEhJanelaPrincipal: true,
    ehFramePrincipal: false, urlDoFrame: APP, appOrigin: APP }), false);
});
