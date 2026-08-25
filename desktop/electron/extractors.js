"use strict";

// ── Extração nativa multi-provider (Electron main process) ────────────────────
// Porta para Node.js a mesma lógica de src/app/api/player/extract/route.ts, para
// que PlayHide, LuluVid, Rola2, Wish, Bolt e Big também rodem com o IP residencial
// do usuário e sem proxy de segmentos pela Vercel — igual ao MegaFlix.
// Ver docs/player-native-extraction.md para o mapa completo de providers.

const { createContext, runInContext } = require("vm");
const { extractSuperflix } = require("./superflix-extractor");

// Opcional: os scripts de diagnóstico carregam este módulo fora do Electron.
let log = null;
try { log = require("./logger"); } catch { /* fora do app */ }
const elog = (level, scope, message, fields) => {
  if (log) log[level](scope, message, fields);
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";
const MOON = "https://app.megafrixapi.com/moon.php";
const REFERER_DEFAULT = "https://megaflix.lat/";
// Usado apenas no corpo POST do rola3/rola4 (campo "r") — preserva o comportamento
// original de extractSecuredLink, anterior à generalização deste módulo.
const OBAFLIX_URL = process.env.OBAFLIX_URL || "https://obaflix.vercel.app";

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchHtml(url, referer = REFERER_DEFAULT, timeoutMs = 8000) {
  const started = Date.now();
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.5",
      "Referer": referer,
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  elog("debug", "extract.http", "GET", {
    http: res.status, dur: `${Date.now() - started}ms`, url: log ? log.shortUrl(url, 110) : url,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

async function moon(obfuscatedScript) {
  const encoded = Buffer.from(obfuscatedScript).toString("base64");
  const res = await fetch(MOON, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://megaflix.lat",
      "Referer": REFERER_DEFAULT,
    },
    body: `data=${encodeURIComponent(encoded)}`,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`moon.php HTTP ${res.status}`);
  return text;
}

async function postPlayer(url, id) {
  const form = new URLSearchParams({ hash: id, r: "" });
  const res = await fetch(`${url}?data=${id}&do=getVideo`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": url,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!text.trimStart().startsWith("{")) throw new Error("Resposta inválida do player");
  const json = JSON.parse(text);
  return json.videoSource || json.src || null;
}

// Extração do rola3/rola4 (embedplayer1/2.xyz, xn--...): POST direto com IP do usuário,
// idêntico ao que já existia como extractSecuredLink em main.js.
async function extractEmbedPlayer(embedUrl, rUrl = OBAFLIX_URL + "/") {
  const parsed = new URL(embedUrl);
  const base = `${parsed.protocol}//${parsed.hostname}`;
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!id) throw new Error("ID não encontrado");

  const apiUrl = `${base}/player/index.php?data=${id}&do=getVideo`;
  const body = new URLSearchParams({ hash: id, r: rUrl });

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
  if (!text.trimStart().startsWith("{")) throw new Error("Resposta inválida do player");
  const data = JSON.parse(text);
  const stream = data.securedLink || data.videoSource || data.src;
  if (!stream) throw new Error("securedLink não encontrado");
  return stream;
}

// ── Packer (Dean Edwards) ────────────────────────────────────────────────────

function directDecodePacker(script) {
  const sq = /\('((?:[^'\\]|\\[\s\S])*)'\s*,\s*(\d+)\s*,\s*\d+\s*,\s*'((?:[^'\\]|\\[\s\S])*)'\s*\.split\('\|'\)/;
  const dq = /\("((?:[^"\\]|\\[\s\S])*)"\s*,\s*(\d+)\s*,\s*\d+\s*,\s*"((?:[^"\\]|\\[\s\S])*)"\s*\.split\("\|"\)/;
  const m = script.match(sq) || script.match(dq);
  if (!m) return null;

  const packed = m[1].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const base = parseInt(m[2], 10);
  const words = m[3].split("|");
  if (base < 2 || base > 36 || words.length === 0) return null;

  return packed.replace(/\b\w+\b/g, (token) => {
    const i = parseInt(token, base);
    return Number.isFinite(i) && i >= 0 && i < words.length && words[i] ? words[i] : token;
  });
}

function unpackPacker(script) {
  const direct = directDecodePacker(script);
  if (direct) return direct;

  try {
    let decoded = null;
    runInContext(script, createContext({ eval: (s) => { decoded = s; } }), { timeout: 500 });
    return decoded;
  } catch {
    return null;
  }
}

function extractEvalScript(html) {
  const idx = html.indexOf("eval(function(p,a,c,k,e,d)");
  if (idx === -1) return null;
  const chunk = html.slice(idx, idx + 50000);
  const endIdx = chunk.search(/\.split\('\|'\)\s*,\s*0\s*,\s*\{\s*\}\s*\)\s*\)/);
  if (endIdx !== -1) return chunk.slice(0, endIdx + 30);
  const scriptEnd = chunk.indexOf("</script>");
  if (scriptEnd !== -1) return chunk.slice(0, scriptEnd);
  return chunk;
}

function findM3u8(text) {
  const patterns = [
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,
    /file:\s*["'](https?:\/\/[^"']+)/i,
    /source:\s*["'](https?:\/\/[^"']+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]?.startsWith("http")) return m[1];
  }
  return null;
}

function parseDecodedHide(decoded, embedUrl) {
  const linksSplit = decoded.split("var links=")[1];
  if (linksSplit) {
    try {
      const links = JSON.parse(linksSplit.split(";")[0].trim());
      const src = links.hls3 || links.hls2 || links.hls4 || null;
      if (src) return src.startsWith("http") ? src : new URL(embedUrl).origin + src;
    } catch { /**/ }
  }
  const linksMatch = decoded.match(/var\s+links\s*=\s*(\{[^;]+\})/);
  if (linksMatch) {
    try {
      const links = JSON.parse(linksMatch[1]);
      const src = links.hls3 || links.hls2 || links.hls4 || null;
      if (src) return src.startsWith("http") ? src : new URL(embedUrl).origin + src;
    } catch { /**/ }
  }
  return findM3u8(decoded);
}

// ── Extratores por provider ──────────────────────────────────────────────────

async function extractHide(embedUrl, id) {
  const html = await fetchHtml(`https://playhide.shop/v/${id}`, REFERER_DEFAULT);
  const evalScript = extractEvalScript(html);
  if (!evalScript) throw new Error("packer não encontrado (PlayHide)");

  const vmDecoded = unpackPacker(evalScript);
  const vmStream = vmDecoded ? parseDecodedHide(vmDecoded, embedUrl) : null;
  if (vmStream) return vmStream;

  const decoded = await moon(evalScript);
  const moonStream = parseDecodedHide(decoded, embedUrl);
  if (!moonStream) throw new Error("stream não encontrado (PlayHide)");
  return moonStream;
}

async function extractLulu(embedUrl) {
  const html = await fetchHtml(embedUrl, REFERER_DEFAULT);
  const evalScript = extractEvalScript(html);
  if (!evalScript) throw new Error("packer não encontrado (Lulu)");
  const decoded = await moon(evalScript);
  const src = decoded.split('[{file:"')[1]?.split('"')[0] ?? null;
  if (src?.startsWith("http")) return src;
  const fallback = findM3u8(decoded);
  if (!fallback) throw new Error("stream não encontrado (Lulu)");
  return fallback;
}

async function extractRola2(id) {
  const src = await postPlayer("https://llanfairpwllgwyngy.com/player/index.php", id);
  if (!src) throw new Error("stream não encontrado (Rola2)");
  return src;
}

async function extractWish(embedUrl, id) {
  const html = await fetchHtml(embedUrl, REFERER_DEFAULT);

  if (id) {
    try {
      const form = new URLSearchParams({ hash: id, r: "", do: "getVideo" });
      const res = await fetch(embedUrl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": REFERER_DEFAULT,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        const src = json?.sources?.[0]?.file || json?.source?.[0]?.file || json?.videoSource || json?.src || null;
        if (src?.startsWith("http")) return src;
      }
    } catch { /* tenta métodos seguintes */ }
  }

  const direct = findM3u8(html);
  if (direct) return direct;

  const fileSplit = html.split('[{file:"')[1]?.split('"')[0];
  if (fileSplit?.startsWith("http")) return fileSplit;

  const jwMatch = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i);
  if (jwMatch?.[1]?.startsWith("http")) return jwMatch[1];

  const jsonFile = html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i);
  if (jsonFile?.[1]) return jsonFile[1];

  const evalScript = extractEvalScript(html);
  if (evalScript) {
    const vmDecoded = unpackPacker(evalScript);
    const vmStream = vmDecoded ? parseDecodedHide(vmDecoded, embedUrl) : null;
    if (vmStream) return vmStream;
    const decoded = await moon(evalScript);
    const moonStream = parseDecodedHide(decoded, embedUrl);
    if (moonStream) return moonStream;
  }
  throw new Error("stream não encontrado (Wish)");
}

async function extractBolt(embedUrl) {
  const html = await fetchHtml(embedUrl, REFERER_DEFAULT);
  const src = html.split('[{file:"')[1]?.split('"')[0];
  if (!src?.startsWith("http")) throw new Error("stream não encontrado (Bolt)");
  return src;
}

async function extractBig(embedUrl) {
  const html = await fetchHtml(embedUrl, REFERER_DEFAULT);
  const src = html.split("url: '")[1]?.split("'")[0];
  if (!src?.startsWith("http")) throw new Error("stream não encontrado (Big)");
  return src;
}

// WatchPlayer: fonte sintética (não vem do banco — ver supportsNativeDesktopExtraction()
// em CustomPlayer.tsx). API própria sem packer/moon.php/CSP — a mais simples de todas.
// Filme: /movie/{tmdbId} → data-id já vem pronto no HTML → POST getPlayer direto.
// Série: /tvshow/{tmdbId}/{season}/{episode} → precisa achar o data-contentid do
// episódio certo, resolver as opções via POST getOptions, e só então POST getPlayer.
async function extractWatchplayer(embedUrl) {
  const parsed = new URL(embedUrl);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const html = await fetchHtml(embedUrl, REFERER_DEFAULT);

  const callApi = async (body) => {
    const res = await fetch("https://v1.watchplay.shop/api", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": embedUrl,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    return res.json();
  };

  let videoId;
  if (parts[0] === "tvshow") {
    const [, , season, episode] = parts;
    const re = new RegExp(`data-contentid="(\\d+)"\\s+data-season="${season}"\\s+data-episode="${episode}"`);
    const contentId = html.match(re)?.[1];
    if (!contentId) throw new Error("episódio não encontrado (WatchPlayer)");

    const optionsJson = await callApi(`action=getOptions&contentid=${contentId}`);
    const options = optionsJson?.data?.options;
    if (!options?.length) throw new Error("opções não encontradas (WatchPlayer)");
    videoId = options[0].ID;
  } else {
    videoId = html.match(/class="player_select_item"\s+data-id="(\d+)"/)?.[1];
    if (!videoId) throw new Error("player não encontrado (WatchPlayer)");
  }

  const playerJson = await callApi(`action=getPlayer&video_id=${videoId}`);
  const src = playerJson?.data?.video_url;
  if (!src) throw new Error("stream não encontrado (WatchPlayer)");
  return src;
}

// ── Router ────────────────────────────────────────────────────────────────────

// Detecta o provider a partir da URL do embed. Mantido em sincronia com
// supportsNativeDesktopExtraction() em src/components/player/CustomPlayer.tsx
// e isNativeExtractionUrl() em PlayerWebViewClient.kt (Android).
function detectProvider(embedUrl) {
  let hostname = "";
  let pathname = "";
  try {
    const parsed = new URL(embedUrl);
    hostname = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    return null;
  }

  if (new URL(embedUrl).protocol !== "https:") return null;
  const hostIs = (...allowed) => allowed.some((host) => hostname === host || hostname.endsWith("." + host));

  if (hostIs("embedplayer1.xyz", "embedplayer2.xyz", "xn--kcksk7a2bl5le7b6doc1h3f.com")) {
    return "embedplayer"; // rola3 (Embv) / rola4 (Xnn)
  }
  if (hostIs("megafrixapi.com", "vods.faz-o-eli.online") && pathname.includes("voltz.php")) return "voltz";
  if (hostIs("luluvdo.com", "lulu.gg", "luluvid.com", "lulustream.com")) return "lulu";
  if (hostIs("playhide.shop", "hidehide.shop", "vidhidehub.com")) return "hide";
  if (hostIs("streamwish.com", "playerwish.com", "hlswish.com", "wishonly.site", "cdnwish.com", "asnwish.com", "swishsrv.com")) return "wish";
  if (hostIs("llanfairpwllgwyngy.com")) return "rola2";
  if (hostIs("boltcdn.xyz", "upbolt.to")) return "bolt";
  if (hostIs("bigshare.link")) return "big";
  if (hostIs("v1.watchplay.shop")) return "watchplayer";
  if (hostIs("superflixapi.pro", "superflixapi.sbs")) return "superflix";
  return null;
}

// Extração nativa genérica: dado o embedUrl, decide o provider e roda o extrator
// correto com o IP residencial do usuário. Retorna { stream, tipo }.
async function extractStream(embedUrl) {
  const provider = detectProvider(embedUrl);
  if (!provider) throw new Error(`Provider não suportado nativamente: ${embedUrl.slice(0, 60)}`);

  const parsed = new URL(embedUrl);
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  const started = Date.now();
  elog("info", "extract.provider", "iniciando extrator", { provider, host: parsed.hostname });

  let stream;
  let referer = embedUrl;
  let subtitles = [];
  // Preenchido apenas pelos extratores que inspecionam o manifesto (SuperFlix).
  let mediaInfo = null;
  switch (provider) {
    case "embedplayer": stream = await extractEmbedPlayer(embedUrl); break;
    case "hide": stream = await extractHide(embedUrl, id); break;
    case "lulu": stream = await extractLulu(embedUrl); break;
    case "rola2": stream = await extractRola2(id); break;
    case "wish": stream = await extractWish(embedUrl, id); break;
    case "bolt": stream = await extractBolt(embedUrl); break;
    case "big": stream = await extractBig(embedUrl); break;
    case "watchplayer": stream = await extractWatchplayer(embedUrl); break;
    case "superflix": {
      const result = await extractSuperflix(embedUrl, {
        ua: UA,
        appReferer: OBAFLIX_URL + "/",
        extractEmbedPlayer,
      });
      stream = result.stream;
      referer = result.referer;
      subtitles = result.subtitles || [];
      mediaInfo = {
        tipo: result.tipo,
        isMaster: Boolean(result.isMaster),
        qualities: result.qualities || [],
        audioTracks: result.audioTracks || [],
        expiresAt: result.expiresAt ?? null,
      };
      break;
    }
    default: throw new Error(`Provider sem extrator: ${provider}`);
  }

  elog("info", "extract.provider", "extrator concluído", {
    provider,
    dur: `${Date.now() - started}ms`,
    cdn: (() => { try { return new URL(stream).hostname; } catch { return "?"; } })(),
    legendas: subtitles.length,
  });

  return {
    stream,
    // O tipo medido vence a adivinhação pela extensão: URLs de HLS sem extensão
    // (e MP4 servidos por rota assinada) eram classificados errado.
    tipo: mediaInfo?.tipo || (stream.includes(".mp4") ? "mp4" : "hls"),
    provider,
    referer,
    subtitles,
    isMaster: mediaInfo?.isMaster ?? false,
    qualities: mediaInfo?.qualities ?? [],
    audioTracks: mediaInfo?.audioTracks ?? [],
    expiresAt: mediaInfo?.expiresAt ?? null,
  };
}

module.exports = { detectProvider, extractStream };
