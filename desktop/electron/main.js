"use strict";

const { app, BrowserWindow, session, ipcMain, shell, Menu } = require("electron");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { setupUpdater } = require("./updater");
const log = require("./logger");
const { detectProvider, extractStream: extractStreamNative } = require("./extractors");
const { extractSuperflixInBrowser } = require("./browser-extractor");

// Qualquer exceção não tratada precisa aparecer no log — antes elas morriam em
// silêncio e o app só "não fazia nada".
process.on("uncaughtException", (err) => log.error("processo", "uncaughtException", err));
process.on("unhandledRejection", (reason) => {
  log.error("processo", "unhandledRejection", reason instanceof Error ? reason : { motivo: String(reason) });
});

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


// Padroes usados na descoberta de hosts do CDN.
const HOST_ABSOLUTO_RE = new RegExp("https?://([^/\\s\"']+)", "g");
const QUEBRA_LINHA_RE = new RegExp("\\r?\\n");
const STREAM_INF_RE = new RegExp("^#EXT-X-STREAM-INF:", "i");
const EXT_MEDIA_RE = new RegExp("^#EXT-X-MEDIA:", "i");
const URI_ATTR_RE = new RegExp("URI=\"([^\"]+)\"", "i");
const PLAYLIST_URL_RE = new RegExp("\\.m3u8|/master\\.txt|/cdn/hls/|/m3/", "i");
// Estado do player ativo — atualizado pelo servidor local após extração bem-sucedida.
// O handler de onBeforeSendHeaders lê esse objeto em tempo de execução (closure por referência).
const playerState = {
  cdnHostname: null,   // hostname principal do manifesto (ex: cdn.boltcdn.xyz)
  embedReferer: null,  // Referer que o CDN espera em todo request (ex: https://embedplayer2.xyz/)
  // Um provedor distribui os segmentos por dezenas de dominios distintos, listados
  // dentro da sub-playlist (penumbra.sbs, permuta.sbs, bacurau.sbs...). Rastrear um
  // hostname so deixava todos eles sem Referer/Origin e sem CORS: net::ERR_FAILED.
  cdnHostnames: new Set(),
};

function allowCdnHost(host) {
  const normalizado = String(host || "").toLowerCase().trim();
  if (normalizado) playerState.cdnHostnames.add(normalizado);
}

function isAllowedCdnHost(host) {
  const normalizado = String(host || "").toLowerCase();
  if (!normalizado) return false;
  for (const permitido of playerState.cdnHostnames) {
    if (normalizado === permitido || normalizado.endsWith("." + permitido)) return true;
  }
  return false;
}

// Le uma playlist e registra todo host absoluto citado nela. O master costuma usar
// caminhos relativos, entao os hosts dos segmentos so aparecem descendo um nivel.
async function learnCdnHostsFromPlaylist(url, referer, profundidade = 1, orcamento = { restantes: 4 }) {
  let texto;
  try {
    const alvo = new URL(url);
    if (alvo.protocol !== "https:") return;
    const cabecalhos = { "User-Agent": UA, Accept: "*/*" };
    if (referer) {
      cabecalhos.Referer = referer;
      try { cabecalhos.Origin = new URL(referer).origin; } catch { /**/ }
    }
    const resposta = await fetch(url, { headers: cabecalhos, signal: AbortSignal.timeout(8000) });
    if (!resposta.ok) return;
    texto = await resposta.text();
  } catch {
    return; // Aprender hosts e melhor-esforco: falhar aqui nao pode quebrar a reproducao.
  }

  if (!texto.trimStart().startsWith("#EXTM3U")) return;

  for (const m of texto.matchAll(HOST_ABSOLUTO_RE)) allowCdnHost(m[1]);

  if (profundidade <= 0) return;

  // Desce nas variantes e nas trilhas de audio para alcancar os hosts de segmento.
  const filhos = [];
  const linhas = texto.split(QUEBRA_LINHA_RE);
  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i].trim();
    if (STREAM_INF_RE.test(linha)) {
      const proxima = (linhas[i + 1] || "").trim();
      if (proxima && !proxima.startsWith("#")) filhos.push(proxima);
    } else if (EXT_MEDIA_RE.test(linha)) {
      const uri = linha.match(URI_ATTR_RE)?.[1];
      if (uri) filhos.push(uri);
    }
  }

  for (const filho of filhos) {
    if (orcamento.restantes <= 0) break;
    orcamento.restantes -= 1;
    let absoluto;
    try { absoluto = new URL(filho, url).toString(); } catch { continue; }
    await learnCdnHostsFromPlaylist(absoluto, referer, profundidade - 1, orcamento);
  }
}

/** Registra o stream extraido e descobre todos os hosts que a cadeia HLS vai usar. */
async function registerPlayerStream(stream, referer) {
  let principal = "";
  try { principal = new URL(stream).hostname; } catch { return; }

  playerState.cdnHostname = principal;
  playerState.embedReferer = referer || null;
  playerState.cdnHostnames = new Set([principal.toLowerCase()]);

  if (PLAYLIST_URL_RE.test(stream)) {
    await learnCdnHostsFromPlaylist(stream, playerState.embedReferer);
  }

  log.info("player.cdn", "estado do player atualizado", {
    cdn: principal,
    hosts: playerState.cdnHostnames.size,
    referer: log.shortUrl(playerState.embedReferer || "-", 80),
  });
}

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
// Quando já existe uma instância aberta, `app.quit()` sozinho não impede que o
// whenReady() abaixo continue montando janela e servidor — foi assim que o boot
// morria com "Object has been destroyed". O flag corta o bootstrap inteiro.
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
  const provider0 = detectProvider(embedUrl);
  const t = log.timer("player.extract", { provider: provider0 || "?", embed: log.shortUrl(embedUrl) });
  try {
    const native = await extractStreamNative(embedUrl);
    t.step("extracao_nativa", { provider: native.provider, tipo: native.tipo, stream: log.shortUrl(native.stream, 90) });
    const { stream, tipo, provider, referer, subtitles } = native;
    await assertPublicHttpsStream(stream);
    t.step("validacao_dns");
    t.done({ provider, tipo, legendas: (subtitles || []).length, cdn: (() => { try { return new URL(stream).hostname; } catch { return "?"; } })() });
    return {
      stream,
      tipo,
      referer,
      subtitles: subtitles || [],
      isMaster: native.isMaster ?? false,
      qualities: native.qualities ?? [],
      audioTracks: native.audioTracks ?? [],
      expiresAt: native.expiresAt ?? null,
    };
  } catch (error) {
    const provider = detectProvider(embedUrl);
    const message = error?.message || String(error);

    if (provider !== "superflix") {
      t.fail(error);
      throw error;
    }

    t.step("extracao_nativa_falhou", { erro: message.slice(0, 160) });
    log.warn("player.extract", "SuperFlix direto falhou — caindo para o fallback Chromium", { erro: message.slice(0, 200) });

    try {
      const result = await extractSuperflixInBrowser(
        embedUrl,
        {
          parentWindow: mainWindow,
          wrapperUrl: `http://127.0.0.1:${localPort}/superflix-wrapper?token=${LOCAL_SERVER_TOKEN}`,
        },
      );
      t.step("fallback_chromium", { stream: log.shortUrl(result.stream, 90) });

      await assertPublicHttpsStream(result.stream);
      t.step("validacao_dns");
      t.done({ provider: "superflix-browser", tipo: result.tipo });
      return result;
    } catch (browserError) {
      t.fail(browserError, { fallback: "chromium" });
      throw browserError;
    }
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
          // Mesmo carregamento dos outros players do app: fundo preto e spinner
          // com o topo vermelho da marca, sem texto sobre o provedor.
          "#superflix-loading{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:#000;pointer-events:none}",
          "#superflix-spinner{width:48px;height:48px;border:4px solid rgba(255,255,255,.2);border-top-color:#E50914;border-radius:50%;animation:sf-spin 1s linear infinite}",
          "@keyframes sf-spin{to{transform:rotate(360deg)}}",
          "#superflix-aviso{position:fixed;top:0;left:0;right:0;z-index:2147483646;display:none;padding:14px 64px 26px;background:linear-gradient(180deg,rgba(0,0,0,.92),rgba(0,0,0,0));color:#fff;font:14px/1.45 Arial,Helvetica,sans-serif;text-align:center;pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.9)}",
          "#superflix-close{position:fixed;top:14px;right:16px;z-index:2147483647;width:42px;height:42px;border:1px solid rgba(255,255,255,.35);border-radius:50%;background:rgba(15,15,18,.9);color:#fff;font-size:22px;cursor:pointer}",
          "#superflix-close:hover{background:rgba(210,35,35,.95)}",
          "</style>",
          "</head>",
          "<body>",
          '<div id="superflix-loading"><div id="superflix-spinner"></div></div>',
          '<div id="superflix-aviso">Escolha um servidor para assistir. Recomendamos o Servidor Alternativo, se estiver disponível.</div>',
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

        const tReq = log.timer("local.extract", { embed: log.shortUrl(embedUrl) });
        try {
          const { stream, tipo, referer } = await extractSecuredLink(embedUrl);
          tReq.step("extraido");

          // Atualiza playerState: o CDN valida Referer = URL completa da página embed
          // (não apenas a origem). O mesmo Referer usado na extração POST.
          try {
            await registerPlayerStream(stream, referer);
          } catch { /**/ }

          res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ stream, tipo, referer: referer || null }));
          tReq.done({ tipo, http: 200 });
        } catch (err) {
          res.writeHead(422, { ...CORS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
          tReq.fail(err, { http: 422 });
        }
        return;
      }

      res.writeHead(404); res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      localPort = server.address().port;
      log.info("local-server", "escutando", { host: "127.0.0.1", porta: localPort });
      resolve(localPort);
    });
    server.on("error", (err) => {
      log.error("local-server", "falha ao iniciar", err);
      reject(err);
    });
  });
}

// ── Janela ─────────────────────────────────────────────────────────────────────
const SPLASH_FILE = path.join(__dirname, "splash.html");

// Carrega o site no window principal. O Chromium continua pintando o documento
// anterior (o splash local) até o novo ter conteúdo para pintar — é isso que
// elimina a janela em branco e aproxima a abertura do MegaFlix.
let bootTimer = null;
let siteLoaded = false;

const windowAlive = () => Boolean(mainWindow) && !mainWindow.isDestroyed();

function loadSite(reason) {
  if (!windowAlive()) { log.warn("janela", "loadSite ignorado: janela já destruída", { motivo: reason }); return; }
  bootTimer = log.timer("boot.site", { url: OBAFLIX_URL, motivo: reason });
  siteLoaded = false;
  log.info("janela", "carregando o site", { url: OBAFLIX_URL, motivo: reason });
  mainWindow.loadURL(OBAFLIX_URL).catch((err) => {
    log.error("janela", "loadURL rejeitou", err);
  });
}

/** Resolve com `true` quando o splash realmente pintou. */
function showSplash(reason) {
  if (!windowAlive()) return Promise.resolve(false);
  siteLoaded = false;
  log.info("janela", "exibindo splash local", { motivo: reason });
  return mainWindow
    .loadFile(SPLASH_FILE)
    .then(() => true)
    .catch((err) => {
      log.error("janela", "falha ao carregar o splash", err);
      return false;
    });
}

function createWindow() {
  const t = log.timer("boot.janela");

  mainWindow = new BrowserWindow({
    width: 1280, height: 720, minWidth: 800, minHeight: 500,
    // Diferente do MegaFlix, que abre com `show` padrão e uma tela local imediata.
    // Aqui fazemos o mesmo: a janela aparece na hora, já pintada com o splash,
    // em vez de ficar invisível esperando a resposta da Vercel.
    show: true,
    backgroundColor: "#111116",
    title: "Obaflix",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: "no-user-gesture-required",
      partition: "persist:obaflix",
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  // MegaFlix maximiza a janela na abertura; sem isso o app abre num retângulo
  // 1280x720 no meio da tela e "parece" outro produto.
  mainWindow.maximize();

  Menu.setApplicationMenu(null);
  configureSession();
  setupWebContents();
  t.step("janela_criada", { bounds: JSON.stringify(mainWindow.getBounds()) });

  showSplash("boot").then((painted) => {
    t.step("splash_pintado", { ok: painted });
    if (!windowAlive()) { t.fail(new Error("janela destruída durante o boot")); return; }
    if (painted) {
      mainWindow.webContents
        .executeJavaScript(`window.obaflixSplash && window.obaflixSplash.version(${JSON.stringify(app.getVersion())})`)
        .catch(() => {});
    }
    loadSite("boot");
    t.done();
  });

  mainWindow.on("closed", () => {
    log.info("janela", "fechada");
    mainWindow = null;
  });
}

// ── Sessão ─────────────────────────────────────────────────────────────────────
function configureSession() {
  const ses = session.fromPartition("persist:obaflix");

  // ── Log de rede ─────────────────────────────────────────────────────────
  // Só o que importa para diagnosticar player: erros HTTP, requests falhados e
  // as chamadas do próprio app. Segmentos de mídia (.ts/.m4s) ficam em `trace`
  // para não afogar o arquivo — suba OBAFLIX_LOG_LEVEL=trace para vê-los.
  // O carimbo de início vem do onSendHeaders porque onBeforeRequest já está ocupado
  // pelo interceptador unificado abaixo (o Electron aceita um listener por evento).
  const startedAt = new Map();
  const isMediaSegment = (url) => /\.(?:ts|m4s|aac|mp4|jpg|png|webp|woff2?|css)(?:$|\?)/i.test(url);

  ses.webRequest.onSendHeaders({ urls: ["*://*/*"] }, (details) => {
    if (startedAt.size > 5000) startedAt.clear();
    startedAt.set(details.id, Date.now());
  });

  ses.webRequest.onCompleted({ urls: ["*://*/*"] }, (details) => {
    const ms = startedAt.has(details.id) ? Date.now() - startedAt.get(details.id) : null;
    startedAt.delete(details.id);
    const fields = {
      metodo: details.method,
      http: details.statusCode,
      tipo: details.resourceType,
      dur: ms === null ? undefined : `${ms}ms`,
      url: log.shortUrl(details.url, 140),
    };
    if (details.statusCode >= 400) log.warn("rede", "resposta com erro", fields);
    else if (isMediaSegment(details.url)) log.trace("rede", "ok", fields);
    else log.debug("rede", "ok", fields);
  });

  ses.webRequest.onErrorOccurred({ urls: ["*://*/*"] }, (details) => {
    const ms = startedAt.has(details.id) ? Date.now() - startedAt.get(details.id) : null;
    startedAt.delete(details.id);
    // net::ERR_ABORTED é rotina (troca de player, navegação) — fica em debug.
    const level = details.error === "net::ERR_ABORTED" ? "debug" : "warn";
    log[level]("rede", "requisição falhou", {
      metodo: details.method,
      erro: details.error,
      tipo: details.resourceType,
      dur: ms === null ? undefined : `${ms}ms`,
      url: log.shortUrl(details.url, 140),
    });
  });

  // ── Permissoes ──────────────────────────────────────────────────────────
  // O app nao precisa de camera, microfone, geolocalizacao, USB nem notificacoes.
  // Mas negar TUDO tambem derrubava o fullscreen: o Chromium trata
  // element.requestFullscreen() como um pedido de permissao ("fullscreen"), entao
  // o handler recusava a tela cheia da reproducao. Como o site engole a rejeicao
  // com .catch(() => {}), o botao simplesmente nao fazia nada e nada era logado.
  //
  // "fullscreen" e "pointerLock" sao capacidades de apresentacao, sempre iniciadas
  // por gesto do usuario e reversiveis com Esc — nao expoem dado nenhum.
  // "mediaKeySystem" e o EME: sem ele, qualquer fonte protegida falha calada.
  const PERMISSOES_LIBERADAS = new Set(["fullscreen", "pointerLock", "mediaKeySystem"]);

  ses.setPermissionCheckHandler((_webContents, permission) => {
    const liberada = PERMISSOES_LIBERADAS.has(permission);
    if (!liberada) log.debug("permissao", "consulta negada", { permissao: permission });
    return liberada;
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const liberada = PERMISSOES_LIBERADAS.has(permission);
    log[liberada ? "debug" : "info"]("permissao", liberada ? "pedido liberado" : "pedido negado", {
      permissao: permission,
    });
    callback(liberada);
  });

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
      if (isAllowedCdnHost(responseHost)) {
        // Como injetamos o Origin do embed na requisição, o CDN devolve um
        // Access-Control-Allow-Origin próprio ecoando esse valor. Acrescentar o
        // nosso por cima deixava dois valores no header e o Chromium recusa:
        // "contains multiple values, but only one is allowed". Remove qualquer
        // grafia existente antes de escrever a nossa.
        for (const chave of Object.keys(rh)) {
          if (/^(access-control-allow-origin|vary)$/i.test(chave)) delete rh[chave];
        }
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
            log.info("intercept", "extract → servidor local", {
              provider: detectProvider(embedUrl),
              embed: log.shortUrl(embedUrl, 100),
            });
            callback({ redirectURL: redirect });
            return;
          }
          log.debug("intercept", "extract segue para a Vercel (sem extrator nativo)", {
            embed: log.shortUrl(embedUrl, 100),
          });
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
            log.debug("intercept", "proxy → CDN direto", { url: log.shortUrl(cdnUrl, 120) });
            callback({ redirectURL: cdnUrl });
            return;
          }
          log.debug("intercept", "proxy segue pela Vercel", {
            temSig: hasSig, temNative: hasNativeParam, url: log.shortUrl(cdnUrl || "-", 100),
          });
        }
      } catch (e) { log.error("intercept", "erro no interceptador", e); }
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
    const isCdnReq = playerState.embedReferer && isAllowedCdnHost(reqHostname);
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

  // ── Ciclo de vida da navegação ─────────────────────────────────────────
  wc.on("did-start-loading", () => log.debug("nav", "did-start-loading", { url: log.shortUrl(wc.getURL(), 120) }));

  wc.on("did-start-navigation", (_e, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    log.info("nav", "navegando", { url: log.shortUrl(url, 140), mesmaPagina: isInPlace });
  });

  wc.on("did-redirect-navigation", (_e, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    log.info("nav", "redirect", { para: log.shortUrl(url, 140) });
  });

  wc.on("did-navigate", (_e, url, httpCode, httpStatus) => {
    log.info("nav", "documento carregado", { url: log.shortUrl(url, 140), http: httpCode, status: httpStatus });
    // A causa mais provável de "404 no aplicativo": o servidor respondeu 404 e o
    // usuário só vê a página de erro do Next. Agora fica explícito no log.
    if (httpCode >= 400) log.error("nav", "a página respondeu com erro HTTP", { http: httpCode, url: log.shortUrl(url, 140) });
  });

  wc.on("did-finish-load", () => {
    const url = wc.getURL();
    log.info("nav", "did-finish-load", { url: log.shortUrl(url, 140) });
    if (url.startsWith(OBAFLIX_ORIGIN)) {
      if (bootTimer && !siteLoaded) { siteLoaded = true; bootTimer.done({ url: log.shortUrl(url, 100) }); bootTimer = null; }
      wc.executeJavaScript("window.__OBAFLIX_DESKTOP__ = true;").catch(() => {});
    }
  });

  wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED: navegação substituída, não é falha
    log.error("nav", "falha ao carregar a página", {
      codigo: errorCode, descricao: errorDescription, url: log.shortUrl(validatedURL, 140),
    });
    if (bootTimer) { bootTimer.fail(new Error(`${errorDescription} (${errorCode})`)); bootTimer = null; }
    // Volta para o splash com o motivo, em vez de deixar a janela em branco.
    showSplash("falha de carga").then(() => {
      wc.executeJavaScript(
        `window.obaflixSplash && window.obaflixSplash.error(${JSON.stringify(`${errorDescription} (${errorCode})`)})`,
      ).catch(() => {});
    });
  });

  // O botão "Reconectar" do splash só muda o hash — é aqui que ele vira ação.
  wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (url.startsWith("file://") && url.includes("#retry-")) loadSite("reconectar");
  });

  wc.on("render-process-gone", (_e, details) => {
    log.error("renderer", "processo do renderer terminou", { motivo: details.reason, exitCode: details.exitCode });
  });

  wc.on("unresponsive", () => log.warn("renderer", "página sem resposta"));
  wc.on("responsive", () => log.info("renderer", "página voltou a responder"));

  // ── Console e erros de JavaScript da página ────────────────────────────
  const CONSOLE_LEVEL = ["debug", "info", "warn", "error"];
  wc.on("console-message", (_e, level, message, line, sourceId) => {
    const name = CONSOLE_LEVEL[level] || "info";
    // O ruído de terceiros (players embed) fica em debug; o que o app registra
    // como warn/error sobe junto com a origem e a linha.
    log[name === "info" ? "debug" : name]("console", message.slice(0, 500), {
      origem: log.shortUrl(sourceId || "-", 100), linha: line,
    });
  });

  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") { mainWindow.setFullScreen(!mainWindow.isFullScreen()); event.preventDefault(); }
    else if (input.key === "F5") { wc.reload(); event.preventDefault(); }
    else if (input.key === "F12") { wc.openDevTools({ mode: "detach" }); event.preventDefault(); }
    // Ctrl+Shift+L abre a pasta de logs — é o que pedimos ao usuário quando algo falha.
    else if (input.key === "L" && input.control && input.shift) {
      const dir = log.getLogDir();
      log.info("app", "abrindo a pasta de logs", { dir });
      if (dir) shell.openPath(dir);
      event.preventDefault();
    }
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
  const t = log.timer("ipc.extract-stream", { embed: log.shortUrl(String(embedUrl ?? ""), 100) });
  try {
    if (!isTrustedIpc(event)) throw new Error("Origem IPC não autorizada");
    if (typeof embedUrl !== "string" || embedUrl.length > 4096) throw new Error("URL inválida");
    const parsed = new URL(embedUrl);
    if (parsed.protocol !== "https:" || !detectProvider(embedUrl)) throw new Error("Provedor não autorizado");
    const { stream, tipo, referer, subtitles } = await extractSecuredLink(embedUrl);
    // CDN valida Referer = URL completa da página embed (não só a origem)
    try {
      await registerPlayerStream(stream, referer);
    } catch { /**/ }
    t.done({ tipo, legendas: (subtitles || []).length });
    return { stream, tipo, referer: referer || null, subtitles: subtitles || [] };
  } catch (err) {
    t.fail(err);
    return { error: err?.message || String(err) };
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (!gotLock) return; // outra instância já está no comando
  const dir = log.initFile(app.getPath("userData"));
  const boot = log.timer("boot", { versao: app.getVersion(), electron: process.versions.electron });
  log.info("app", "iniciando", {
    versao: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    plataforma: `${process.platform} ${process.arch}`,
    empacotado: app.isPackaged,
    site: OBAFLIX_URL,
    logs: dir,
  });

  try {
    await startLocalServer();
    boot.step("servidor_local", { porta: localPort });
    createWindow();
    boot.step("janela");
    setupUpdater(mainWindow);
    boot.step("updater");
    boot.done();
  } catch (err) {
    boot.fail(err);
    throw err;
  }

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  log.info("app", "todas as janelas fechadas");
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => log.info("app", "encerrando"));
