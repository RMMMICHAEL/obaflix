"use strict";

// ── Extração nativa multi-provider (Electron main process) ────────────────────
// Porta para Node.js a mesma lógica de src/app/api/player/extract/route.ts, para
// que PlayHide, LuluVid, Rola2, Wish, Bolt e Big também rodem com o IP residencial
// do usuário e sem proxy de segmentos pela Vercel — igual ao MegaFlix.
// Ver docs/player-native-extraction.md para o mapa completo de providers.

const { createContext, runInContext } = require("vm");

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
async function extractEmbedPlayer(embedUrl) {
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

  if (pathname.includes("/rola3/") || pathname.includes("/rola4/") || hostname.includes("embedplayer") || /xn--kcksk7a2bl5le7b6doc1h3f/.test(hostname)) {
    return "embedplayer"; // rola3 (Embv) / rola4 (Xnn)
  }
  if (hostname.includes("lulu")) return "lulu";
  if (hostname.includes("hide") || hostname.includes("playhide")) return "hide";
  if (hostname.includes("wish")) return "wish"; // streamwish, hlswish, playerwish
  if (hostname.includes("llanfair") || pathname.includes("/rola/")) return "rola2";
  if (hostname.includes("boltcdn") || hostname.includes("bolt")) return "bolt";
  if (hostname.includes("bigshare") || hostname.includes("big")) return "big";
  return null;
}

// Extração nativa genérica: dado o embedUrl, decide o provider e roda o extrator
// correto com o IP residencial do usuário. Retorna { stream, tipo }.
async function extractStream(embedUrl) {
  const provider = detectProvider(embedUrl);
  if (!provider) throw new Error(`Provider não suportado nativamente: ${embedUrl.slice(0, 60)}`);

  const parsed = new URL(embedUrl);
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";

  let stream;
  switch (provider) {
    case "embedplayer": stream = await extractEmbedPlayer(embedUrl); break;
    case "hide": stream = await extractHide(embedUrl, id); break;
    case "lulu": stream = await extractLulu(embedUrl); break;
    case "rola2": stream = await extractRola2(id); break;
    case "wish": stream = await extractWish(embedUrl, id); break;
    case "bolt": stream = await extractBolt(embedUrl); break;
    case "big": stream = await extractBig(embedUrl); break;
    default: throw new Error(`Provider sem extrator: ${provider}`);
  }

  return { stream, tipo: stream.includes(".mp4") ? "mp4" : "hls", provider };
}

module.exports = { detectProvider, extractStream };
