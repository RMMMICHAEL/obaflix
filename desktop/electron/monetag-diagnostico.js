"use strict";

// ── Diagnóstico A/B da Monetag (só com --diagnostico-monetag) ─────────────────
//
// Pergunta: o 204 da zona vem do iframe sandbox (origem opaca, sem IndexedDB),
// da identidade do cliente (navigator.userAgent com "Electron", header de UA
// sobrescrito e client hints divergentes) ou de falta de inventário?
//
//   A  = o app como está: iframe sandbox "allow-scripts allow-popups" na janela
//        principal. Só observado — nada muda nele.
//   B1 = janela própria carregando /desktop/banner.html NO TOPO (origem normal,
//        IndexedDB disponível), mesma identidade do app.
//   B2 = igual a B1, com user agent de Chrome consistente (sem "Electron").
//
// Fronteira das janelas B (o anúncio roda com origem normal, então o
// isolamento vem do processo principal, não do sandbox de iframe):
//   - SEM preload: não há ponte obaflixDesktop nem ipcRenderer no renderer, e
//     isTrustedIpc exige a janela principal de qualquer forma;
//   - sandbox, contextIsolation, nodeIntegration=false, webSecurity;
//   - partição própria em memória (sem "persist:"), uma por janela: não vê
//     cookie/storage/sessão do app e some ao fechar;
//   - navegação do frame principal presa ao documento do banner; window.open
//     segue window-policy (https externo → navegador do sistema, resto negado);
//   - toda permissão negada; download cancelado.
//
// Saída: <userData>/logs/diagnostico-monetag/<carimbo>/relatorio.json + PNGs,
// e a pasta é aberta ao fim. Nenhum cookie é gravado — só se havia.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DURACAO_MS = 90_000;

// Mesma régua do detector de public/desktop/banner.html, rodada pelo processo
// principal no documento do anúncio.
const MEDIR_JS = `(() => {
  const IGN = new Set(["HTML","HEAD","BODY","SCRIPT","STYLE","LINK","META","TITLE","NOSCRIPT","TEMPLATE","BASE"]);
  const PINTA = new Set(["IMG","IFRAME","VIDEO","CANVAS","SVG","PICTURE","OBJECT","EMBED"]);
  const achados = [];
  for (const el of document.documentElement.getElementsByTagName("*")) {
    if (IGN.has(el.tagName.toUpperCase()) || (document.head && document.head.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 30) continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
    const cs = getComputedStyle(el);
    const vis = el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : cs.display !== "none";
    const pinta = PINTA.has(el.tagName.toUpperCase()) || cs.backgroundImage !== "none" || /rgba?\\((?![^)]*,\\s*0\\))/.test(cs.backgroundColor) || [...el.childNodes].some((n) => n.nodeType === 3 && /\\S/.test(n.nodeValue));
    if (vis && pinta) achados.push(el.tagName.toLowerCase() + " " + Math.round(r.width) + "x" + Math.round(r.height));
  }
  return { criativo: achados.length > 0, elementos: achados.slice(0, 5), origem: self.origin, url: location.href.replace(/[?#].*$/, ""), ua: navigator.userAgent };
})()`;

const TESTAR_IDB_JS = `new Promise((ok) => {
  try {
    const r = indexedDB.open("obaflix-diagnostico");
    r.onsuccess = () => { try { r.result.close(); } catch (e) {} ok("abriu"); };
    r.onerror = () => ok("erro " + (r.error && r.error.name));
  } catch (e) { ok("lançou " + e.name); }
})`;

function cabecalho(headers, nome) {
  const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === nome);
  return k ? headers[k] : undefined;
}

function criarGravador() {
  const envios = new Map();
  const chamadas = [];
  return {
    chamadas,
    envio(details) {
      const h = details.requestHeaders || {};
      envios.set(details.id, {
        metodo: details.method,
        origin: cabecalho(h, "origin") ?? "(ausente)",
        referer: cabecalho(h, "referer") ?? "(ausente)",
        userAgent: cabecalho(h, "user-agent"),
        secChUa: cabecalho(h, "sec-ch-ua"),
        enviouCookie: !!cabecalho(h, "cookie"),
      });
    },
    fim(details, erro) {
      const e = envios.get(details.id) || {};
      envios.delete(details.id);
      chamadas.push({
        quando: new Date().toISOString(),
        url: details.url.length > 200 ? details.url.slice(0, 200) + "…" : details.url,
        tipo: details.resourceType,
        status: erro ? null : details.statusCode,
        erro: erro || undefined,
        ...e,
      });
    },
  };
}

function resumir(chamadas, zona) {
  const daZona = chamadas.filter((c) => c.url.includes(`/${zona}`) && c.metodo === "POST");
  const tag = chamadas.find((c) => /\/tag\.min\.js/.test(c.url));
  return {
    tagMinJs: tag ? tag.status ?? tag.erro : "não solicitada",
    chamadasDaZona: daZona.map((c) => ({ status: c.status ?? c.erro, origin: c.origin, referer: c.referer })),
    statusDaZona: [...new Set(daZona.map((c) => c.status ?? c.erro))],
  };
}

/**
 * @param {object} deps  app, BrowserWindow, session, shell, log, politica,
 *                       OBAFLIX_URL, OBAFLIX_ORIGIN, UA (header do app), zona.
 */
function criar(deps) {
  const { app, BrowserWindow, session, shell, log, politica, OBAFLIX_URL, OBAFLIX_ORIGIN, UA } = deps;
  const zona = deps.zona || "11917353";
  const gravadorA = criarGravador();
  const janelasB = [];
  let iniciado = false;
  const ehFrameDoBanner = (details) => {
    try { return !!details.frame && politica.ehDocumentoDoBanner(details.frame.url, OBAFLIX_ORIGIN); } catch { return false; }
  };

  function abrirJanelaB(nome, { uaConsistente }) {
    const ses = session.fromPartition(`diag-monetag-${nome}-${crypto.randomBytes(6).toString("hex")}`);
    const gravador = criarGravador();
    const uaChrome = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;
    if (uaConsistente) ses.setUserAgent(uaChrome);

    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.on("will-download", (e) => e.preventDefault());
    ses.webRequest.onBeforeSendHeaders({ urls: ["*://*/*"] }, (details, cb) => {
      const h = { ...details.requestHeaders };
      // B1 reproduz exatamente o header do app; B2 fica com o UA consistente da sessão.
      if (!uaConsistente) h["User-Agent"] = UA;
      // O middleware só entrega /desktop/* ao app: roteamento, não credencial.
      if (details.url.startsWith(OBAFLIX_ORIGIN)) h["X-Obaflix-Client"] = "desktop";
      cb({ requestHeaders: h });
    });
    ses.webRequest.onSendHeaders({ urls: ["*://*/*"] }, (d) => gravador.envio(d));
    ses.webRequest.onCompleted({ urls: ["*://*/*"] }, (d) => gravador.fim(d));
    ses.webRequest.onErrorOccurred({ urls: ["*://*/*"] }, (d) => gravador.fim(d, d.error));

    const win = new BrowserWindow({
      width: 820, height: 260, x: 40 + janelasB.length * 40, y: 40 + janelasB.length * 300,
      title: `Diagnóstico Monetag — ${nome}`, autoHideMenuBar: true, backgroundColor: "#111116",
      webPreferences: {
        // Sem preload, de propósito.
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        session: ses, devTools: !app.isPackaged,
      },
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      const d = politica.decidirJanelaNova(url, OBAFLIX_ORIGIN);
      if (d.acao === "externo") shell.openExternal(d.url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      if (!politica.ehDocumentoDoBanner(url, OBAFLIX_ORIGIN)) e.preventDefault();
    });
    wc.on("will-redirect", (e, url) => {
      if (!politica.ehDocumentoDoBanner(url, OBAFLIX_ORIGIN)) e.preventDefault();
    });
    win.loadURL(`${OBAFLIX_URL.replace(/\/+$/, "")}/desktop/banner.html#feed`).catch((err) => {
      log.warn("diagnostico", "janela B não carregou", { janela: nome, erro: String(err && err.message) });
    });
    const b = { nome, win, gravador, uaConsistente };
    janelasB.push(b);
    return b;
  }

  async function coletar(dir, mainWindow) {
    const relatorio = {
      geradoEm: new Date().toISOString(),
      app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
      site: OBAFLIX_URL, zona,
      A_sandbox_atual: {},
      B: {},
    };

    // A: frames do banner dentro da janela principal.
    try {
      const frames = mainWindow.webContents.mainFrame.framesInSubtree
        .filter((f) => { try { return politica.ehDocumentoDoBanner(f.url, OBAFLIX_ORIGIN); } catch { return false; } });
      const amostras = [];
      for (const f of frames.slice(0, 4)) {
        amostras.push({
          indexedDB: await f.executeJavaScript(TESTAR_IDB_JS).catch((e) => "falhou " + e.message),
          medicao: await f.executeJavaScript(MEDIR_JS).catch((e) => ({ erro: e.message })),
        });
      }
      relatorio.A_sandbox_atual = {
        framesDoBanner: frames.length,
        observacao: frames.length ? undefined : "nenhum banner na tela: abra a Home/Filmes com conta gratuita e rode de novo",
        amostras,
        ...resumir(gravadorA.chamadas, zona),
        chamadas: gravadorA.chamadas,
      };
      const png = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(dir, "A-janela-principal.png"), png.toPNG());
    } catch (e) {
      relatorio.A_sandbox_atual = { erro: String(e && e.message) };
    }

    for (const b of janelasB) {
      if (b.win.isDestroyed()) { relatorio.B[b.nome] = { erro: "janela fechada antes da coleta" }; continue; }
      const wc = b.win.webContents;
      relatorio.B[b.nome] = {
        uaConsistente: b.uaConsistente,
        indexedDB: await wc.executeJavaScript(TESTAR_IDB_JS).catch((e) => "falhou " + e.message),
        medicao: await wc.executeJavaScript(MEDIR_JS).catch((e) => ({ erro: e.message })),
        ...resumir(b.gravador.chamadas, zona),
        chamadas: b.gravador.chamadas,
      };
      try { fs.writeFileSync(path.join(dir, `${b.nome}.png`), (await wc.capturePage()).toPNG()); } catch { /* janela fechada */ }
    }
    return relatorio;
  }

  return {
    // Chamados pelos handlers da sessão principal (só registram frames do banner).
    envio(details) { if (ehFrameDoBanner(details)) gravadorA.envio(details); },
    conclusao(details) { if (ehFrameDoBanner(details)) gravadorA.fim(details); },
    falha(details) { if (ehFrameDoBanner(details)) gravadorA.fim(details, details.error); },

    iniciar(mainWindow) {
      if (iniciado) return;
      iniciado = true;
      const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
      const dir = path.join(app.getPath("userData"), "logs", "diagnostico-monetag", carimbo);
      fs.mkdirSync(dir, { recursive: true });
      log.info("diagnostico", "A/B da Monetag iniciado", { segundos: DURACAO_MS / 1000, pasta: dir });
      abrirJanelaB("B1-isolado-ua-do-app", { uaConsistente: false });
      abrirJanelaB("B2-isolado-ua-chrome", { uaConsistente: true });
      setTimeout(async () => {
        try {
          const rel = await coletar(dir, mainWindow);
          fs.writeFileSync(path.join(dir, "relatorio.json"), JSON.stringify(rel, null, 2));
          log.info("diagnostico", "relatório gravado", {
            A: JSON.stringify(rel.A_sandbox_atual.statusDaZona),
            B1: JSON.stringify(rel.B["B1-isolado-ua-do-app"]?.statusDaZona),
            B2: JSON.stringify(rel.B["B2-isolado-ua-chrome"]?.statusDaZona),
          });
          shell.openPath(dir);
        } catch (e) {
          log.error("diagnostico", "falha ao gerar relatório", e);
        }
      }, DURACAO_MS);
    },
  };
}

module.exports = { criar, criarGravador, resumir, MEDIR_JS, TESTAR_IDB_JS, DURACAO_MS };
