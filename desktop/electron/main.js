"use strict";

const { app, BrowserWindow, session, ipcMain, shell, Menu } = require("electron");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { setupUpdater } = require("./updater");
const { detectProvider, extractStream: extractStreamNative } = require("./extractors");
const { extractSuperflixInBrowser } = require("./browser-extractor");

const OBAFLIX_URL = process.env.OBAFLIX_URL || "https://obaflix.vercel.app";
const OBAFLIX_ORIGIN = new URL(OBAFLIX_URL).origin;
const LOCAL_SERVER_TOKEN = crypto.randomBytes(32).toString("base64url");
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
  "v1.watchplay.shop",
  "vods.faz-o-eli.online",
  "superflixapi.pro", "vizero.buzz", "warezcdn.lat",
];

// Estado do player ativo — atualizado pelo servidor local após extração bem-sucedida.
// O handler de onBeforeSendHeaders lê esse objeto em tempo de execução (closure por referência).
const playerState = {
  cdnHostname: null,   // hostname do CDN onde ficam os segmentos HLS (ex: cdn.boltcdn.xyz)
  embedReferer: null,  // Referer que o CDN espera em todo request (ex: https://embedplayer2.xyz/)
};

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const low = ip.toLowerCase();
  return low === "::" || low === "::1" || low.startsWith("fc") || low.startsWith("fd") ||
    low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb") ||
    low.startsWith("ff") || low.startsWith("::ffff:");
}

async function assertPublicHttpsStream(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Stream inseguro");
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Destino de stream bloqueado");
  }
  return raw;
}

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
// Dispatcher genérico (rola3/rola4, PlayHide, Lulu, Rola2, Wish, Bolt, Big) —
// ver desktop/electron/extractors.js e docs/player-native-extraction.md.
async function extractSecuredLink(embedUrl) {
  try {
    const { stream, tipo, provider, referer, subtitles } = await extractStreamNative(embedUrl);
    console.log(`[extract] provider=${provider} stream_resolved=true`);
    await assertPublicHttpsStream(stream);
    return { stream, tipo, referer, subtitles: subtitles || [] };
  } catch (error) {
    const provider = detectProvider(embedUrl);
    const message = error?.message || String(error);

    if (provider !== "superflix") throw error;

    console.warn(`[extract] SuperFlix direto falhou: ${message}`);
    console.warn("[extract] tentando fallback Chromium...");

    const result = await extractSuperflixInBrowser(
      embedUrl,
      {
        parentWindow: mainWindow,
        wrapperUrl: `http://127.0.0.1:${localPort}/superflix-wrapper?token=${LOCAL_SERVER_TOKEN}`,
      },
    );
    console.log("[extract] provider=superflix-browser stream_resolved=true");

    await assertPublicHttpsStream(result.stream);
    return result;
  }
}

// ── Servidor local ─────────────────────────────────────────────────────────────
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.searchParams.get("token") !== LOCAL_SERVER_TOKEN) {
        res.writeHead(403, { "Cache-Control": "no-store" });
        res.end("Forbidden");
        return;
      }

      const requestOrigin = req.headers.origin || "";
      const CORS = {
        ...(requestOrigin === OBAFLIX_ORIGIN
          ? { "Access-Control-Allow-Origin": OBAFLIX_ORIGIN, "Vary": "Origin" }
          : {}),
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        // Chromium Private Network Access: sem este header, um fetch vindo de um site
        // "público" (obaflix.vercel.app) para 127.0.0.1 é bloqueado no preflight com
        // "Request had no target IP address space, yet the resource is in address
        // space 'local'" — mesmo com Access-Control-Allow-Origin: "*". Necessário para
        // o fallback via onBeforeRequest (redirect de /api/player/extract) funcionar.
        "Access-Control-Allow-Private-Network": "true",
      };

      if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }

      if (url.pathname === "/superflix-wrapper") {
        const html = [
          "<!doctype html>",
          '<html lang="pt-BR">',
          "<head>",
          '<meta charset="utf-8">',
          '<meta name="viewport" content="width=device-width,initial-scale=1">',
          '<meta name="referrer" content="no-referrer">',
          "<style>",
          "*{box-sizing:border-box}",
          "html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#000}",
          "#superflix-frame{position:fixed;inset:0;display:block;width:100%;height:100%;border:0;background:#000}",
          "#superflix-loading{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font:16px Arial,sans-serif;pointer-events:none}",
          "#superflix-close{position:fixed;top:14px;right:16px;z-index:2147483647;width:42px;height:42px;border:1px solid rgba(255,255,255,.35);border-radius:50%;background:rgba(15,15,18,.9);color:#fff;font-size:22px;cursor:pointer}",
          "#superflix-close:hover{background:rgba(210,35,35,.95)}",
          "</style>",
          "</head>",
          "<body>",
          '<div id="superflix-loading">Carregando servidores do SuperFlix...</div>',
          '<button id="superflix-close" type="button" title="Fechar" onclick="location.href=\'obaflix-superflix://close\'">×</button>',
          '<iframe id="superflix-frame" allow="autoplay; fullscreen; encrypted-media"></iframe>',
          "</body>",
          "</html>",
        ].join("");

        res.writeHead(200, {
          ...CORS,
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "Pragma": "no-cache",
          "Referrer-Policy": "no-referrer",
        });

        res.end(html);
        return;
      }


      if (url.pathname === "/extract") {
        const embedUrl = url.searchParams.get("embedUrl");
        if (!embedUrl) { res.writeHead(400, CORS); res.end("embedUrl obrigatório"); return; }

        console.log(`[local] extract: ${embedUrl.slice(0, 80)}`);
        try {
          const { stream, tipo, referer } = await extractSecuredLink(embedUrl);
          console.log("[local] stream resolved");

          // Atualiza playerState: o CDN valida Referer = URL completa da página embed
          // (não apenas a origem). O mesmo Referer usado na extração POST.
          try {
            playerState.cdnHostname = new URL(stream).hostname;
            playerState.embedReferer = referer || null;
            console.log(`[local] CDN: ${playerState.cdnHostname} | Referer: ${playerState.embedReferer}`);
          } catch { /**/ }

          res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ stream, tipo, referer: referer || null }));
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
      sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
      partition: "persist:obaflix",
      // Desativa CORS no renderer — idêntico ao WebView do MegaFlix Android
      webSecurity: true,
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

  // The streaming shell does not need camera, microphone, geolocation, USB,
  // notifications or other privileged Chromium permissions.
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  // ── Strip CSP do Vercel ─────────────────────────────────────────────────
  // O header Content-Security-Policy (connect-src 'self') bloqueia requests do
  // renderer para CDNs externos mesmo com webSecurity:false (CSP é independente de SOP).
  // Removemos o CSP das respostas do Vercel para que o redirect proxy→CDN funcione.
  ses.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    (details, callback) => {
      const rh = { ...details.responseHeaders };
      let responseOrigin = "";
      let responseHost = "";
      try {
        const parsed = new URL(details.url);
        responseOrigin = parsed.origin;
        responseHost = parsed.hostname;
      } catch { /**/ }
      if (responseOrigin === OBAFLIX_ORIGIN) {
        delete rh["content-security-policy"];
        delete rh["Content-Security-Policy"];
        delete rh["content-security-policy-report-only"];
      }
      const cdnHost = playerState.cdnHostname;
      if (cdnHost && (responseHost === cdnHost || responseHost.endsWith("." + cdnHost))) {
        rh["Access-Control-Allow-Origin"] = [OBAFLIX_ORIGIN];
        rh["Vary"] = ["Origin"];
      }
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

        // 1. /api/player/extract para providers com extração nativa → servidor local
        //    (extrai com IP do usuário). Cobre rola3/rola4/hide/lulu/rola2/wish/bolt/big —
        //    ver desktop/electron/extractors.js e docs/player-native-extraction.md.
        if (url.pathname === "/api/player/extract") {
          const embedUrl = url.searchParams.get("url") || "";
          const hasNativeExtractor = !!detectProvider(embedUrl);

          if (hasNativeExtractor && localPort) {
            const redirect = `http://127.0.0.1:${localPort}/extract?token=${LOCAL_SERVER_TOKEN}&embedUrl=${encodeURIComponent(embedUrl)}`;
            console.log(`[intercept/extract] → local: ${embedUrl.slice(0, 60)}`);
            callback({ redirectURL: redirect });
            return;
          }
        }

        // 2. /api/player/proxy?url=CDN_URL → redireciona direto ao CDN (bypassa Vercel)
        //    Token CDN é IP-bound ao IP do usuário; Vercel tem IP diferente → 403.
        //    CSP foi removido por onHeadersReceived — redirect ao CDN é permitido.
        //
        //    Identificação do path: o CustomPlayer.tsx marca explicitamente as URLs do path
        //    nativo Electron/Android (qualquer provider com extração nativa, via IPC/bridge)
        //    com "native=1" (ver buildElectronProxyUrl).
        //    URLs com "sig" são segmentos reescritos pelo proxy Vercel (path web/warez2/W3) —
        //    o token deles é IP-bound ao IP do VERCEL, não do usuário; redirecionar direto
        //    para o CDN nesse caso causa 403/404. Por isso NUNCA bypassamos quando há "sig".
        //    Fallback (!hasSig sem "native" presente) cobre janela de deploy com bundle do
        //    site ainda em cache sem o marcador — não depende de versão nova do exe nem do site.
        //    TODO: remover o fallback (hasNativeParam ? ... : true) quando todos os usuários
        //    estiverem em uma versão do site que sempre envia "native=1" — manter o fallback
        //    indefinidamente é mais um caminho implícito a testar/manter sem necessidade.
        if (url.pathname === "/api/player/proxy") {
          const cdnUrl = url.searchParams.get("url");
          const hasSig = url.searchParams.has("sig");
          const hasNativeParam = url.searchParams.has("native");
          const isNativeRola34 = url.searchParams.get("native") === "1";
          const shouldBypassToCdn = !!cdnUrl && !hasSig && (hasNativeParam ? isNativeRola34 : true);
          if (shouldBypassToCdn) {
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
    const isEmbedReq = EMBED_HOSTNAMES.some((host) => reqHostname === host || reqHostname.endsWith("." + host));
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

  const isAppUrl = (raw) => {
    try { return new URL(raw).origin === OBAFLIX_ORIGIN; } catch { return false; }
  };
  const openExternalHttp = (raw) => {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "https:") shell.openExternal(parsed.href);
    } catch { /**/ }
  };

  wc.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) { openExternalHttp(url); return { action: "deny" }; }
    return { action: "allow" };
  });

  wc.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      const isLocalWrapper = parsed.origin === `http://127.0.0.1:${localPort}` &&
        parsed.searchParams.get("token") === LOCAL_SERVER_TOKEN;
      if (!isAppUrl(url) && !isLocalWrapper) {
        event.preventDefault();
        openExternalHttp(url);
      }
    } catch { event.preventDefault(); }
  });

  wc.on("did-finish-load", () => {
    wc.executeJavaScript("window.__OBAFLIX_DESKTOP__ = true;").catch(() => {});
  });

  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") { mainWindow.setFullScreen(!mainWindow.isFullScreen()); event.preventDefault(); }
    else if (input.key === "F5") { wc.reload(); event.preventDefault(); }
    else if (input.key === "F12" && !app.isPackaged) { wc.openDevTools(); event.preventDefault(); }
    else if (input.key === "Escape" && mainWindow.isFullScreen()) { mainWindow.setFullScreen(false); event.preventDefault(); }
  });
}

// ── IPC ────────────────────────────────────────────────────────────────────────
function isTrustedIpc(event) {
  try { return new URL(event.senderFrame.url).origin === OBAFLIX_ORIGIN; } catch { return false; }
}

ipcMain.handle("toggle-fullscreen", (event) => {
  if (!isTrustedIpc(event)) return false;
  mainWindow?.setFullScreen(!mainWindow.isFullScreen());
  return true;
});
ipcMain.handle("get-version", (event) => isTrustedIpc(event) ? app.getVersion() : null);
ipcMain.handle("install-update", (event) => {
  if (!isTrustedIpc(event)) return false;
  require("electron-updater").autoUpdater.quitAndInstall(false, true);
  return true;
});

// Extração nativa multi-provider: o site chama window.obaflixDesktop.extractStream()
// → ipcRenderer.invoke("extract-stream") → aqui → Node.js fetch com IP do usuário.
// Cobre qualquer provider com extrator em desktop/electron/extractors.js — a decisão de
// QUANDO chamar este caminho (em vez do fluxo web via Vercel) é feita no site por
// supportsNativeDesktopExtraction() (src/components/player/CustomPlayer.tsx).
ipcMain.handle("extract-stream", async (event, embedUrl) => {
  try {
    if (!isTrustedIpc(event)) throw new Error("Origem IPC não autorizada");
    if (typeof embedUrl !== "string" || embedUrl.length > 4096) throw new Error("URL inválida");
    const parsed = new URL(embedUrl);
    if (parsed.protocol !== "https:" || !detectProvider(embedUrl)) throw new Error("Provedor não autorizado");
    const { stream, tipo, referer, subtitles } = await extractSecuredLink(embedUrl);
    // CDN valida Referer = URL completa da página embed (não só a origem)
    try {
      playerState.cdnHostname = new URL(stream).hostname;
      playerState.embedReferer = referer || null;
      console.log(`[ipc] CDN: ${playerState.cdnHostname} | Referer: ${playerState.embedReferer}`);
    } catch { /**/ }
    return { stream, tipo, referer: referer || null, subtitles: subtitles || [] };
  } catch (err) {
    console.error("[ipc] extract-stream error:", err);
    return { error: err?.message || String(err) };
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
