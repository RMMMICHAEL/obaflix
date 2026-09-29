"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const politica = require("../window-policy");

const APP = "https://obaflix.vercel.app";
const BANNER = `${APP}/desktop/banner.html`;
const ADS = "https://obaflix-ads.vercel.app";
const ANUNCIO = `${ADS}/banner.html#feed`;
const COM_GESTO = { gestoRecente: true };

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
    const d = politica.decidirJanelaNova(url, APP, COM_GESTO);
    assert.ok(d.acao === "externo" || d.acao === "negar", url);
    assert.notEqual(d.acao, "permitir", url);
  }
});

test("window.open: https externo vai ao navegador do sistema; URL do app é negada", () => {
  assert.deepEqual(politica.decidirJanelaNova("https://example.com/landing", APP, COM_GESTO), {
    acao: "externo", url: "https://example.com/landing",
  });
  assert.deepEqual(politica.decidirJanelaNova(`${APP}/desktop`, APP, COM_GESTO), { acao: "negar", motivo: "janela_do_app" });
  // Planos/checkout continuam indo ao navegador, como antes.
  assert.equal(politica.decidirJanelaNova(`${APP}/planos?plano=basic`, APP, COM_GESTO).acao, "externo");
  assert.equal(politica.decidirJanelaNova(`${APP}/checkout/abc`, APP, COM_GESTO).acao, "externo");
});

test("window.open sem gesto real nunca sai ao navegador (anúncio não abre o navegador sozinho)", () => {
  for (const opcoes of [undefined, {}, { gestoRecente: false }, { gestoRecente: "true" }, { gestoRecente: 1 }]) {
    assert.deepEqual(politica.decidirJanelaNova("https://anunciante.test/oferta", APP, opcoes), {
      acao: "negar", motivo: "sem_gesto",
    }, JSON.stringify(opcoes));
  }
  // Esquema ruim continua "esquema", com ou sem gesto.
  assert.equal(politica.decidirJanelaNova("javascript:alert(1)", APP).motivo, "esquema");
});

test("gesto: vale por JANELA_DO_GESTO_MS, 0 = consumido; só clique/tecla/toque contam", () => {
  const J = politica.JANELA_DO_GESTO_MS;
  assert.ok(J > 0 && J <= 1000, "janela curta: gesto no app não pode virar popup do anúncio");
  assert.equal(politica.gestoRecente(10_000, 10_000), true);
  assert.equal(politica.gestoRecente(10_000, 10_000 + J), true);
  assert.equal(politica.gestoRecente(10_000, 10_000 + J + 1), false);
  assert.equal(politica.gestoRecente(0, 500), false, "consumido");
  assert.equal(politica.gestoRecente(10_000, 9_000), false, "relógio para trás");
  for (const t of ["mouseDown", "mouseUp", "keyDown", "rawKeyDown", "touchStart", "gestureTap"]) assert.ok(politica.GESTOS.has(t), t);
  for (const t of ["mouseMove", "mouseEnter", "mouseLeave", "mouseWheel", "gestureScrollUpdate", "keyUp", "char"]) assert.ok(!politica.GESTOS.has(t), t);
});

test("window.open: esquema não-https nunca sai (nem para o navegador)", () => {
  for (const url of [
    "http://evil.test/", "file:///etc/passwd", "file:///C:/Windows/system32/calc.exe", "javascript:alert(1)",
    "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:msgbox(1)",
    "blob:https://obaflix-ads.vercel.app/abc", "ms-msdt:/id", "search-ms:query=x", "obaflix://x", "lixo",
  ]) {
    const d = politica.decidirJanelaNova(url, APP, COM_GESTO);
    assert.equal(d.acao, "negar", url);
    assert.equal(politica.destinoExternoSeguro(url), null, url);
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

test("origem dos anúncios: reconhecida exatamente, sem host parecido", () => {
  assert.equal(politica.ORIGEM_DOS_ANUNCIOS, ADS);
  assert.equal(politica.ehOrigemDeAnuncio(ANUNCIO), true);
  assert.equal(politica.ehOrigemDeAnuncio(`blob:${ADS}/uuid`), true, "blob herda a origem");
  assert.equal(politica.ehFrameDeAnuncio(ANUNCIO, APP), true);
  assert.equal(politica.ehFrameDeAnuncio(`${ADS}/banner.html#player`, APP), true);
  assert.equal(politica.ehFrameDeAnuncio(BANNER, APP), true, "documento antigo, sandboxed, continua reconhecido");
  assert.equal(politica.ehFrameDeAnuncio(`${ADS}/`, APP), false);
  for (const url of [
    "http://obaflix-ads.vercel.app/banner.html",
    "https://obaflix-ads.vercel.app.evil.test/banner.html",
    "https://evil.test/https://obaflix-ads.vercel.app/banner.html",
    "https://obaflix-ads.vercel.app@evil.test/banner.html",
    "https://x.obaflix-ads.vercel.app/banner.html",
    `${APP}/banner.html`,
  ]) {
    assert.equal(politica.ehOrigemDeAnuncio(url), false, url);
    assert.equal(politica.ehFrameDeAnuncio(url, APP), false, url);
  }
  // O próprio app nunca é tratado como anúncio.
  assert.equal(politica.ehOrigemDeAnuncio(`${APP}/desktop`), false);
});

test("iframe do anúncio (ads-site) não sai do próprio documento; frames dentro dele carregam o criativo", () => {
  const nav = (urlAtual, destino) =>
    politica.decidirNavegacaoDeSubframe({ isMainFrame: false, urlAtual, destino, appOrigin: APP });
  assert.equal(nav("about:blank", ANUNCIO), "seguir", "carga inicial");
  assert.equal(nav(ANUNCIO, `${ADS}/banner.html#detalhe`), "seguir", "só o hash muda");
  for (const destino of [
    "https://evil.test/", `${ADS}/f.exe`, `${ADS}/banner.html?x=1`, `${APP}/conta`,
    "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd",
  ]) {
    assert.equal(nav(ANUNCIO, destino), "cancelar", destino);
  }
  // Criativo (frame filho do anúncio) segue livre dentro do iframe.
  assert.equal(nav("https://criativo.test/c.html", "https://criativo.test/d.html"), "seguir");
});

test("janela principal: anúncio e frames dentro dele nunca a trocam, nem para o app", () => {
  const topo = { url: `${APP}/desktop`, origin: APP };
  const anuncio = { url: ANUNCIO, origin: ADS };
  const criativo = { url: "https://criativo.test/c.html", origin: "https://criativo.test" };
  const semUrl = { url: "about:blank", origin: ADS };
  const dec = (destino, cadeiaDoIniciador) => politica.decidirNavegacaoPrincipal({ destino, cadeiaDoIniciador, appOrigin: APP });

  for (const destino of ["https://evil.test/", `${APP}/conta`, `${APP}/planos`, "javascript:alert(1)", "file:///C:/x.exe", `${ADS}/x`]) {
    assert.equal(dec(destino, [anuncio, topo]), "bloquear", `anúncio → ${destino}`);
    assert.equal(dec(destino, [criativo, anuncio, topo]), "bloquear", `criativo → ${destino}`);
    assert.equal(dec(destino, [semUrl, anuncio, topo]), "bloquear", `about:blank do anúncio → ${destino}`);
    assert.equal(dec(destino, [{ url: BANNER, origin: "null" }, topo]), "bloquear", `banner antigo → ${destino}`);
  }
  // O próprio app segue a regra de sempre (main.js decide interno × navegador).
  assert.equal(dec(`${APP}/conta`, [topo]), "seguir");
  assert.equal(dec("https://externo.test/", [topo]), "seguir");
  // Player embed (/assistir) segue a regra de sempre.
  assert.equal(dec("https://externo.test/", [{ url: "https://player.exemplo/e/1", origin: "https://player.exemplo" }, topo]), "seguir");
  // Iniciador desconhecido: dentro do app segue; para fora, bloqueia sem abrir nada.
  assert.equal(dec(`${APP}/conta`, null), "seguir");
  assert.equal(dec("https://evil.test/", null), "bloquear");
  assert.equal(dec("https://evil.test/", []), "bloquear");
});

test("download: só com toda a cadeia na origem do app; anúncio e terceiros cancelados", () => {
  const dec = (cadeiaDeUrls) => politica.decidirDownload({ cadeiaDeUrls, appOrigin: APP });
  assert.equal(dec([`${APP}/arquivo.bin`]), "permitir");
  for (const cadeia of [
    [`${ADS}/f.exe`],
    [`blob:${ADS}/uuid`],
    ["https://evil.test/m.exe"],
    [`${APP}/redir`, "https://evil.test/m.exe"],
    ["data:application/octet-stream;base64,TVo="],
    ["https://obaflix.vercel.app.evil.test/m.exe"],
    [],
    undefined,
  ]) {
    assert.equal(dec(cadeia), "cancelar", JSON.stringify(cadeia));
  }
});

test("permissões: origem dos anúncios não recebe nenhuma, nem as liberadas ao app", () => {
  const liberadas = new Set(["fullscreen", "pointerLock", "mediaKeySystem"]);
  const ok = (permissao, origens) => politica.permissaoLiberada({ permissao, origens, liberadas });
  assert.equal(ok("fullscreen", [APP]), true);
  assert.equal(ok("fullscreen", ["https://player.exemplo"]), true, "player embed segue como antes");
  assert.equal(ok("notifications", [APP]), false);
  for (const p of ["fullscreen", "pointerLock", "mediaKeySystem", "notifications", "media", "geolocation", "clipboard-read"]) {
    assert.equal(ok(p, [ADS]), false, p);
    assert.equal(ok(p, [APP, ANUNCIO]), false, `${p} (anúncio como requestingUrl)`);
  }
});

test("main.js: anúncio sem preload/IPC/nodeIntegration e com as guardas ligadas", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  // O único preload é o da janela principal (frame principal), com isolamento.
  assert.equal((main.match(/preload:\s*path\.join\(__dirname, "preload\.js"\)/g) || []).length, 1);
  assert.ok(!/nodeIntegration:\s*true/.test(main));
  assert.ok(!/nodeIntegrationInSubFrames:\s*true/.test(main));
  assert.ok(!/contextIsolation:\s*false/.test(main));
  assert.ok(!/webSecurity:\s*false/.test(main.replace(/\/\/.*$/gm, "")));
  // Guardas no processo principal.
  assert.match(main, /politica\.decidirNavegacaoPrincipal\(/);
  assert.match(main, /if \(bloquearTopoDoAnuncio\(event, url\)\) return;/);
  assert.match(main, /if \(details\.isMainFrame\) \{ bloquearTopoDoAnuncio\(details, details\.url\); return; \}/);
  assert.match(main, /ses\.on\("will-download"/);
  assert.match(main, /politica\.decidirDownload\(/);
  assert.match(main, /politica\.permissaoLiberada\(/);
  assert.match(main, /wc\.on\("before-mouse-event", registrarGesto\)/);
  assert.match(main, /wc\.on\("input-event", registrarGesto\)/);
  assert.match(main, /gestoRecente: politica\.gestoRecente\(ultimoGestoEm, Date\.now\(\)\)/);
  assert.match(main, /ultimoGestoEm = 0; shell\.openExternal\(decisao\.url\)/, "um gesto, uma abertura");
  // A navegação recusada do topo não vai ao navegador (seria popunder).
  const bloqueio = main.slice(main.indexOf("const bloquearTopoDoAnuncio"), main.indexOf("wc.on(\"will-frame-navigate\""));
  assert.ok(!/openExternal/.test(bloqueio));
  // Preload só expõe a ponte ao frame principal: o Electron não injeta preload em subframe sem nodeIntegrationInSubFrames.
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("obaflixDesktop"/);
});

test("IPC: só frame principal da janela principal, na origem do app", () => {
  const ok = { remetenteEhJanelaPrincipal: true, ehFramePrincipal: true, urlDoFrame: `${APP}/desktop`, appOrigin: APP };
  assert.equal(politica.ipcConfiavel(ok), true);
  assert.equal(politica.ipcConfiavel({ ...ok, ehFramePrincipal: false }), false, "subframe de mesma origem");
  assert.equal(politica.ipcConfiavel({ ...ok, ehFramePrincipal: false, urlDoFrame: BANNER }), false, "iframe do banner");
  assert.equal(politica.ipcConfiavel({ ...ok, ehFramePrincipal: false, urlDoFrame: ANUNCIO }), false, "iframe do anúncio");
  assert.equal(politica.ipcConfiavel({ ...ok, urlDoFrame: ANUNCIO }), false, "origem dos anúncios");
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
  assert.equal(nivel("error", false, ANUNCIO), "trace");
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
