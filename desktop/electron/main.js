"use strict";

const { app, BrowserWindow, session, ipcMain, shell, Menu } = require("electron");
const http = require("http");
const path = require("path");
const { setupUpdater } = require("./updater");

const OBAFLIX_URL = process.env.OBAFLIX_URL || "https://obaflix.vercel.app";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";

// Hostnames dos embed players (sem wildcards — usados no handler unificado)
const EMBED_HOSTNAMES = [
  "embedplayer2.xyz", "embedplayer1.xyz",
  "xn--kcksk7a2bl5le7b6doc1h3f.com", "llanfairpwllgwyngy.com",
  "playhide.shop", "streamwish.com", "hlswish.com",
  "playerwish.com", "jvrkt.online", "beamy.online",
  "boltcdn.xyz", "bigshare.link", "luluvdo.com",
];

// Estado do player ativo — atualizado pelo servidor local após extração bem-sucedida.
// O handler de onBeforeSendHeaders lê esse objeto em tempo de execução (closure por referência).
const playerState = {
  cdnHostname: null,   // hostname do CDN onde ficam os segmentos HLS (ex: cdn.boltcdn.xyz)
  embedReferer: null,  // Referer que o CDN espera em todo request (ex: https://embedplayer2.xyz/)
};

let mainWindow = null;
let localPort = null;

// ── Instância única ────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on("second-instance", () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
}

// ── Extração com IP do usuário (Node.js, sem CORS) ────────────────────────────
async function extractSecuredLink(embedUrl) {
  const parsed = new URL(embedUrl);
  const base = `${parsed.protocol}//${parsed.hostname}`;
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!id) throw new Error("ID não encontrado");

  const apiUrl = `${base}/player/index.php?data=${id}&do=getVideo`;
  const body = new URLSearchParams({ hash: id, r: OBAFLIX_URL + "/" });

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": embedUrl,
      "Origin": base,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  console.log(`[extract] ${res.status} → ${text.slice(0, 120)}`);
  if (!text.trimStart().startsWith("{")) throw new Error("Resposta inválida do player");

  const data = JSON.parse(text);
  const stream = data.securedLink || data.videoSource || data.src;
  if (!stream) throw new Error("securedLink não encontrado");
  return { stream, embedOrigin: base };
}

// ── Servidor local ─────────────────────────────────────────────────────────────
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const CORS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      };

      if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

      const url = new URL(req.url, "http://127.0.0.1");

      if (url.pathname === "/extract") {
        const embedUrl = url.searchParams.get("embedUrl");
        if (!embedUrl) { res.writeHead(400, CORS); res.end("embedUrl obrigatório"); return; }

        console.log(`[local] extract: ${embedUrl.slice(0, 80)}`);
        try {
          const { stream, embedOrigin } = await extractSecuredLink(embedUrl);
          console.log(`[local] stream: ${stream.slice(0, 80)}`);

          // Atualiza playerState: o CDN valida Referer = URL completa da página embed
          // (não apenas a origem). O mesmo Referer usado na extração POST.
          try {
            playerState.cdnHostname = new URL(stream).hostname;
            playerState.embedReferer = embedUrl;
            console.log(`[local] CDN: ${playerState.cdnHostname} | Referer: ${playerState.embedReferer}`);
          } catch { /**/ }

          res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
          res.end(JSON.stringify({
            stream,
            tipo: stream.includes(".mp4") ? "mp4" : "hls",
            referer: embedUrl,
          }));
        } catch (err) {
          console.error(`[local] erro: ${err.message}`);
          res.writeHead(422, { ...CORS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      res.writeHead(404); res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      localPort = server.address().port;
      console.log(`[local-server] porta ${localPort}`);
      resolve(localPort);
    });
    server.on("error", reject);
  });
}

// ── Janela ─────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 720, minWidth: 800, minHeight: 500,
    show: false, backgroundColor: "#111116", title: "Obaflix",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",
      partition: "persist:obaflix",
      // Desativa CORS no renderer — idêntico ao WebView do MegaFlix Android
      webSecurity: false,
    },
  });

  mainWindow.once("ready-to-show", () => { mainWindow.show(); mainWindow.focus(); });
  Menu.setApplicationMenu(null);
  configureSession();
  setupWebContents();
  mainWindow.loadURL(OBAFLIX_URL);
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── Sessão ─────────────────────────────────────────────────────────────────────
function configureSession() {
  const ses = session.fromPartition("persist:obaflix");

  // ── Strip CSP do Vercel ─────────────────────────────────────────────────
  // O header Content-Security-Policy (connect-src 'self') bloqueia requests do
  // renderer para CDNs externos mesmo com webSecurity:false (CSP é independente de SOP).
  // Removemos o CSP das respostas do Vercel para que o redirect proxy→CDN funcione.
  ses.webRequest.onHeadersReceived(
    { urls: [`${OBAFLIX_URL}/*`] },
    (details, callback) => {
      const rh = { ...details.responseHeaders };
      delete rh["content-security-policy"];
      delete rh["Content-Security-Policy"];
      delete rh["content-security-policy-report-only"];
      callback({ responseHeaders: rh });
    }
  );

  // ── Intercept: rola3/4 e bypass do proxy Vercel ─────────────────────────
  // Electron só permite UM onBeforeRequest por sessão — tudo unificado aqui.
  // Padrão único /api/player/* cobre extract e proxy; pathname filtrado no handler.
  ses.webRequest.onBeforeRequest(
    { urls: [`${OBAFLIX_URL}/api/player/*`] },
    (details, callback) => {
      try {
        const url = new URL(details.url);

        // 1. /api/player/extract para rola3/rola4 → servidor local (extrai com IP do usuário)
        if (url.pathname === "/api/player/extract") {
          const embedUrl = url.searchParams.get("url") || "";
          const isRola34 =
            /\/(rola3|rola4)\//.test(embedUrl) ||
            /embedplayer/.test(embedUrl) ||
            /xn--kcksk7a2bl5le7b6doc1h3f/.test(embedUrl);

          if (isRola34 && localPort) {
            const redirect = `http://127.0.0.1:${localPort}/extract?embedUrl=${encodeURIComponent(embedUrl)}`;
            console.log(`[intercept/extract] → local: ${embedUrl.slice(0, 60)}`);
            callback({ redirectURL: redirect });
            return;
          }
        }

        // 2. /api/player/proxy?url=CDN_URL → redireciona direto ao CDN (bypassa Vercel)
        //    Token CDN é IP-bound ao IP do usuário; Vercel tem IP diferente → 403.
        //    CSP foi removido por onHeadersReceived — redirect ao CDN é permitido.
        if (url.pathname === "/api/player/proxy") {
          const cdnUrl = url.searchParams.get("url");
          if (cdnUrl) {
            console.log(`[intercept/proxy] → CDN direto: ${cdnUrl.slice(0, 80)}`);
            callback({ redirectURL: cdnUrl });
            return;
          }
        }
      } catch (e) { console.error("[intercept]", e.message); }
      callback({});
    }
  );

  // ── ÚNICO handler de onBeforeSendHeaders — injeta User-Agent, Referer, Origin ──
  // Nota: Electron permite apenas UM listener por evento por sessão.
  // Registrar dois substituiria o anterior — por isso tudo está unificado aqui.
  ses.webRequest.onBeforeSendHeaders({ urls: ["*://*/*"] }, (details, callback) => {
    const h = { ...details.requestHeaders };

    // 1. User-Agent em todos os requests
    h["User-Agent"] = UA;

    // 2. Requests para os embed players (extração, página do player)
    const reqHostname = (() => { try { return new URL(details.url).hostname; } catch { return ""; } })();
    const isEmbedReq = EMBED_HOSTNAMES.some((host) => reqHostname.endsWith(host));
    if (isEmbedReq) {
      if (!h["Referer"] && !h["referer"]) h["Referer"] = OBAFLIX_URL + "/";
      if (details.method === "POST") h["X-Requested-With"] = "XMLHttpRequest";
    }

    // 3. Requests para o CDN (segmentos HLS / manifest) — injeta Referer do embed
    // Equivale ao que o ExoPlayer do MegaFlix faz: envia Referer em todo request de mídia.
    // playerState é atualizado pelo servidor local após extração bem-sucedida.
    // Usa endsWith para cobrir subdomínios do CDN (ex: cdn.dahds13.xyz).
    const isCdnReq =
      playerState.cdnHostname &&
      playerState.embedReferer &&
      (reqHostname === playerState.cdnHostname ||
        reqHostname.endsWith("." + playerState.cdnHostname));
    if (isCdnReq) {
      const embedOriginForCdn = (() => {
        try { const u = new URL(playerState.embedReferer); return u.origin; } catch { return ""; }
      })();
      h["Referer"] = playerState.embedReferer;
      if (embedOriginForCdn) h["Origin"] = embedOriginForCdn;
    }

    callback({ requestHeaders: h });
  });
}

// ── WebContents ────────────────────────────────────────────────────────────────
function setupWebContents() {
  const wc = mainWindow.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(OBAFLIX_URL)) { shell.openExternal(url); return { action: "deny" }; }
    return { action: "allow" };
  });

  wc.on("will-navigate", (event, url) => {
    try {
      if (!url.startsWith(OBAFLIX_URL) && !url.startsWith("http://127.0.0.1")) {
        const parsed = new URL(url);
        const isEmbed = EMBED_HOSTNAMES.some((host) => parsed.hostname.endsWith(host));
        if (!isEmbed) { event.preventDefault(); shell.openExternal(url); }
      }
    } catch { }
  });

  wc.on("did-finish-load", () => {
    wc.executeJavaScript("window.__OBAFLIX_DESKTOP__ = true;").catch(() => {});
  });

  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") { mainWindow.setFullScreen(!mainWindow.isFullScreen()); event.preventDefault(); }
    else if (input.key === "F5") { wc.reload(); event.preventDefault(); }
    else if (input.key === "F12") { wc.openDevTools(); event.preventDefault(); }
    else if (input.key === "Escape" && mainWindow.isFullScreen()) { mainWindow.setFullScreen(false); event.preventDefault(); }
  });
}

// ── IPC ────────────────────────────────────────────────────────────────────────
ipcMain.handle("toggle-fullscreen", () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()));
ipcMain.handle("get-version", () => app.getVersion());
ipcMain.handle("install-update", () => require("electron-updater").autoUpdater.quitAndInstall(false, true));

// Extração nativa para rola3/rola4: o site chama window.obaflixDesktop.extractStream()
// → ipcRenderer.invoke("extract-stream") → aqui → Node.js fetch com IP do usuário
ipcMain.handle("extract-stream", async (_event, embedUrl) => {
  try {
    const { stream, embedOrigin } = await extractSecuredLink(embedUrl);
    // CDN valida Referer = URL completa da página embed (não só a origem)
    try {
      playerState.cdnHostname = new URL(stream).hostname;
      playerState.embedReferer = embedUrl;
      console.log(`[ipc] CDN: ${playerState.cdnHostname} | Referer: ${embedUrl}`);
    } catch { /**/ }
    return { stream, tipo: stream.includes(".mp4") ? "mp4" : "hls", referer: embedUrl };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await startLocalServer();
  createWindow();
  setupUpdater(mainWindow);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
