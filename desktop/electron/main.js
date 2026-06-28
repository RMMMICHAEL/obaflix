"use strict";

const { app, BrowserWindow, session, ipcMain, shell, Menu } = require("electron");
const http = require("http");
const path = require("path");
const { setupUpdater } = require("./updater");

const OBAFLIX_URL = process.env.OBAFLIX_URL || "https://obaflix.vercel.app";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";

const EMBED_URL_PATTERNS = [
  "*://*.embedplayer2.xyz/*", "*://*.embedplayer1.xyz/*",
  "*://*.xn--kcksk7a2bl5le7b6doc1h3f.com/*", "*://*.llanfairpwllgwyngy.com/*",
  "*://*.playhide.shop/*", "*://*.streamwish.com/*", "*://*.hlswish.com/*",
  "*://*.playerwish.com/*", "*://*.jvrkt.online/*", "*://*.beamy.online/*",
  "*://*.boltcdn.xyz/*", "*://*.bigshare.link/*", "*://*.luluvdo.com/*",
];

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

// ── Extração com IP do usuário (sem CORS, processo Node.js) ──────────────────
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
  return stream;
}

// ── Servidor local ─────────────────────────────────────────────────────────────
// Único endpoint: /extract?embedUrl=...
// Retorna { stream: securedLink, tipo: "hls" } — o IP do securedLink é o do usuário.
// Com webSecurity: false no renderer, JW Player busca os segmentos direto da CDN
// sem restrição de CORS, igual ao WebView do Megaflix Android.
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
          const stream = await extractSecuredLink(embedUrl);
          console.log(`[local] stream: ${stream.slice(0, 80)}`);
          res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ stream, tipo: stream.includes(".mp4") ? "mp4" : "hls" }));
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
      // Desativa CORS no renderer — idêntico ao comportamento do WebView Android do Megaflix
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

  // Intercepta /api/player/extract para rola3/rola4 → servidor local (IP do usuário)
  ses.webRequest.onBeforeRequest(
    { urls: [`${OBAFLIX_URL}/api/player/extract*`] },
    (details, callback) => {
      try {
        const url = new URL(details.url);
        const embedUrl = url.searchParams.get("url") || "";
        const isRola34 =
          /\/(rola3|rola4)\//.test(embedUrl) ||
          /embedplayer/.test(embedUrl) ||
          /xn--kcksk7a2bl5le7b6doc1h3f/.test(embedUrl);

        if (isRola34 && localPort) {
          const redirect = `http://127.0.0.1:${localPort}/extract?embedUrl=${encodeURIComponent(embedUrl)}`;
          console.log(`[intercept] → local: ${embedUrl.slice(0, 60)}`);
          callback({ redirectURL: redirect });
          return;
        }
      } catch (e) { console.error("[intercept]", e.message); }
      callback({});
    }
  );

  // Headers para players embed externos
  ses.webRequest.onBeforeSendHeaders({ urls: EMBED_URL_PATTERNS }, (details, callback) => {
    const h = { ...details.requestHeaders };
    if (!h["Referer"] && !h["referer"]) h["Referer"] = OBAFLIX_URL + "/";
    h["User-Agent"] = UA;
    if (details.method === "POST") h["X-Requested-With"] = "XMLHttpRequest";
    callback({ requestHeaders: h });
  });

  // User-Agent global
  ses.webRequest.onBeforeSendHeaders({ urls: ["*://*/*"] }, (details, callback) => {
    const h = { ...details.requestHeaders };
    h["User-Agent"] = UA;
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
        const isEmbed = EMBED_URL_PATTERNS.some((p) =>
          parsed.hostname.endsWith(p.replace("*://", "").replace("*.", "").split("/")[0])
        );
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

// ── Bootstrap ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await startLocalServer();
  createWindow();
  setupUpdater(mainWindow);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
