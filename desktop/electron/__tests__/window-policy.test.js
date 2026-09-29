"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const politica = require("../window-policy");

const APP = "https://obaflix.vercel.app";
const BANNER = `${APP}/desktop/banner.html`;

test("window.open: nenhuma URL cria janela Electron", () => {
  for (const url of [
    `${APP}/desktop`,
    `${APP}/filme/1`,
    `${APP}/desktop/banner.html`,
    "https://example.com/landing",
    "http://evil.test/login",
    "file:///C:/Windows/system32/calc.exe",
    "javascript:alert(1)",
    "obaflix://auth/callback",
  ]) {
    const d = politica.decidirJanelaNova(url, APP);
    assert.ok(d.acao === "externo" || d.acao === "negar", url);
    assert.notEqual(d.acao, "permitir", url);
  }
});

test("window.open: https externo vai ao navegador do sistema; URL do app é negada", () => {
  assert.deepEqual(politica.decidirJanelaNova("https://example.com/landing", APP), {
    acao: "externo", url: "https://example.com/landing",
  });
  assert.deepEqual(politica.decidirJanelaNova(`${APP}/desktop`, APP), { acao: "negar", motivo: "janela_do_app" });
  // Planos/checkout continuam indo ao navegador, como antes.
  assert.equal(politica.decidirJanelaNova(`${APP}/planos?plano=basic`, APP).acao, "externo");
  assert.equal(politica.decidirJanelaNova(`${APP}/checkout/abc`, APP).acao, "externo");
});

test("window.open: esquema não-https nunca sai (nem para o navegador)", () => {
  for (const url of ["http://evil.test/", "file:///etc/passwd", "javascript:alert(1)", "obaflix://x", "lixo"]) {
    assert.equal(politica.decidirJanelaNova(url, APP).acao, "negar", url);
  }
});

test("o app não é confundido com host parecido", () => {
  for (const url of [
    "https://obaflix.vercel.app.evil.test/desktop",
    "https://evil.test/https://obaflix.vercel.app/desktop",
    "https://obaflix.vercel.app@evil.test/desktop",
  ]) {
    assert.equal(politica.ehDoApp(url, APP), false, url);
    assert.equal(politica.ehDocumentoDoBanner(url, APP), false, url);
  }
});

test("iframe do banner não sai do próprio documento; outros iframes seguem livres", () => {
  const nav = (urlAtual, destino, isMainFrame = false) =>
    politica.decidirNavegacaoDeSubframe({ isMainFrame, urlAtual, destino, appOrigin: APP });

  assert.equal(nav(BANNER, "https://example.com/landing"), "cancelar");
  assert.equal(nav(BANNER, `${APP}/conta`), "cancelar");
  assert.equal(nav(BANNER, `${APP}/arquivo.exe`), "cancelar");
  assert.equal(nav(BANNER, BANNER), "seguir");
  // Carga inicial do iframe (about:blank → banner)
  assert.equal(nav("about:blank", BANNER), "seguir");
  // Player embed em /assistir: livre, como sempre
  assert.equal(nav("https://player.exemplo/e/abc", "https://player.exemplo/e/def"), "seguir");
  // Frame principal nunca é tratado aqui (will-navigate cuida dele)
  assert.equal(nav(BANNER, "https://example.com", true), "seguir");
});

test("IPC: só frame principal da janela principal, na origem do app", () => {
  const ok = { remetenteEhJanelaPrincipal: true, ehFramePrincipal: true, urlDoFrame: `${APP}/desktop`, appOrigin: APP };
  assert.equal(politica.ipcConfiavel(ok), true);
  assert.equal(politica.ipcConfiavel({ ...ok, ehFramePrincipal: false }), false, "subframe de mesma origem");
  assert.equal(politica.ipcConfiavel({ ...ok, ehFramePrincipal: false, urlDoFrame: BANNER }), false, "iframe do banner");
  assert.equal(politica.ipcConfiavel({ ...ok, remetenteEhJanelaPrincipal: false }), false, "outra janela");
  assert.equal(politica.ipcConfiavel({ ...ok, urlDoFrame: "http://evil.test/login" }), false, "origem externa");
  assert.equal(politica.ipcConfiavel({ ...ok, urlDoFrame: "file:///splash.html" }), false, "splash local");
});

test("console: erro real do Obaflix continua ERROR; só o iframe do banner vai para trace", () => {
  const nivel = (level, isMainFrame, frameUrl) =>
    politica.nivelDoConsole({ level, isMainFrame, frameUrl, appOrigin: APP });

  // Frame principal do Obaflix: nada muda
  assert.equal(nivel("error", true, `${APP}/desktop`), "error");
  assert.equal(nivel("warning", true, `${APP}/filme/1`), "warn");
  assert.equal(nivel("info", true, `${APP}/desktop`), "debug");
  assert.equal(nivel("debug", true, `${APP}/desktop`), "debug");
  // Mesmo que o frame principal esteja em /desktop/banner.html (URL aberta direto), segue ERROR
  assert.equal(nivel("error", true, BANNER), "error");
  // Subframes que não são o banner (players embed): nada muda
  assert.equal(nivel("error", false, "https://player.exemplo/e/abc"), "error");
  assert.equal(nivel("error", false, `${APP}/outra-rota`), "error");
  // Só o iframe do banner
  assert.equal(nivel("error", false, BANNER), "trace");
  assert.equal(nivel("warning", false, BANNER), "trace");
  // Frame desconhecido (destruído): comportamento anterior
  assert.equal(nivel("error", true, ""), "error");
});

test("main.js usa a política (sem allow em window.open e com IPC por frame principal)", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.ok(!/action:\s*"allow"/.test(main), "nenhum window.open pode devolver allow");
  assert.match(main, /politica\.decidirJanelaNova\(/);
  assert.match(main, /politica\.decidirNavegacaoDeSubframe\(/);
  assert.match(main, /politica\.nivelDoConsole\(/);
  assert.match(main, /politica\.ipcConfiavel\(/);
  assert.match(main, /wc\.on\("will-frame-navigate"/);
});

test("logger tem trace abaixo de debug (o padrão grava debug, não trace)", () => {
  const logger = fs.readFileSync(path.join(__dirname, "..", "logger.js"), "utf8");
  assert.match(logger, /trace/);
  const log = require("../logger");
  assert.equal(typeof log.trace, "function");
});
