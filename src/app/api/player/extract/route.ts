export const dynamic = "force-dynamic";
export const maxDuration = 60;
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl } from "@/lib/ssrf";
import {
  verifyPlayToken,
  createStreamToken,
  signSegmentUrl,
  isIpBlocked,
  recordAbuseAttempt,
} from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function clientUa(req: NextRequest): string {
  return req.headers.get("user-agent") || "unknown";
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const MOON = "https://app.megafrixapi.com/moon.php";

// ── Diagnóstico de extração ───────────────────────────────────────────────────
// Logs estruturados por etapa: [extract/<provider>/<fase>] k=v k=v
// Pesquisável nos logs do Vercel. Removível quando a causa raiz for confirmada.

function xlog(tag: string, data: Record<string, string | number | boolean | null | undefined>) {
  const parts = Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[extract/${tag}] ${parts}`);
}

// Detecta sinais de bloqueio no HTML — distingue CloudFlare/403/conteúdo curto de HTML normal.
function detectHtmlHint(html: string): string | null {
  if (html.length < 500) return `short_${html.length}b`;
  if (/just a moment|cf-browser-verification|cf_captcha_container/i.test(html)) return "cloudflare_challenge";
  if (/access.?denied|403 forbidden/i.test(html)) return "access_denied";
  if (/challenges\.cloudflare\.com/i.test(html)) return "cloudflare_turnstile";
  if (!html.includes("<html") && !html.includes("<!DOCTYPE")) return "no_html_tag";
  return null;
}

// Versão de fetchHtml com logging diagnóstico completo: status HTTP, tempo, redirect, hint.
// Usar apenas para PlayHide e StreamWish — demais providers não precisam da sobrecarga.
async function fetchHtmlDiag(tag: string, url: string, referer: string, timeoutMs = 8000): Promise<string> {
  const t0 = Date.now();
  let statusCode = 0;
  let logged = false;

  const log = (extra: Record<string, string | number | boolean | null | undefined>) => {
    logged = true;
    xlog(`${tag}/fetch`, { ms: Date.now() - t0, status: statusCode || null, ...extra });
  };

  try {
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
    statusCode = res.status;
    if (!res.ok) {
      log({ error: `http_${statusCode}`, redirected: res.redirected || null });
      throw new Error(`HTTP ${statusCode} em ${url}`);
    }
    const html = await res.text();
    const originHost = (() => { try { return new URL(url).hostname; } catch { return null; } })();
    const finalHost = (() => { try { return new URL(res.url).hostname; } catch { return null; } })();
    log({
      htmlLen: html.length,
      redirected: res.redirected || null,
      domainChanged: finalHost !== originHost ? finalHost : null,
      hint: detectHtmlHint(html),
    });
    return html;
  } catch (e: any) {
    if (!logged) {
      const ms = Date.now() - t0;
      const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError" || ms >= timeoutMs - 50;
      log({ error: isTimeout ? `timeout_${timeoutMs}ms` : String(e?.name ?? e?.message).slice(0, 80) });
    }
    throw e;
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchHtml(url: string, referer = "", timeoutMs = 8000): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.5",
      "Referer": referer || new URL(url).origin + "/",
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

async function moon(obfuscatedScript: string): Promise<string> {
  const t = Date.now();
  const encoded = Buffer.from(obfuscatedScript).toString("base64");
  let statusCode = 0;
  try {
    const res = await fetch(MOON, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://megaflix.lat",
        "Referer": "https://megaflix.lat/",
      },
      body: `data=${encodeURIComponent(encoded)}`,
      signal: AbortSignal.timeout(8000),
    });
    statusCode = res.status;
    const text = await res.text();
    if (!res.ok) {
      xlog("moon", { ms: Date.now() - t, status: statusCode, error: `http_${statusCode}` });
      throw new Error(`moon.php HTTP ${res.status}`);
    }
    xlog("moon", { ms: Date.now() - t, status: statusCode, resultLen: text.length });
    return text;
  } catch (e: any) {
    const ms = Date.now() - t;
    if (!String(e?.message ?? "").includes("moon.php HTTP")) {
      const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      xlog("moon", { ms, status: statusCode || null, error: isTimeout ? "timeout_8000ms" : String(e?.message).slice(0, 60) });
    }
    throw e;
  }
}

async function postPlayer(url: string, id: string): Promise<string> {
  const form = new URLSearchParams();
  form.append("hash", id);
  form.append("r", "");
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
  const json = JSON.parse(text);
  return json.videoSource || json.src || "";
}

async function postEmbedPlayer(embedUrl: string): Promise<string> {
  const workerUrl = process.env.EMBED_WORKER_URL;
  const workerSecret = process.env.EMBED_WORKER_SECRET ?? "";

  if (workerUrl) {
    try {
      const res = await fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Secret": workerSecret,
        },
        body: JSON.stringify({ url: embedUrl }),
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const text = await res.text();
        if (text.trimStart().startsWith("{")) {
          const json = JSON.parse(text);
          const src = json.securedLink || json.videoSource || json.src || "";
          if (src) return src;
        }
      }
    } catch { /* fallback para direto */ }
  }

  const parsed = new URL(embedUrl);
  const base = `${parsed.protocol}//${parsed.hostname}`;
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!id) return "";

  const form = new URLSearchParams();
  form.append("hash", id);
  form.append("r", "https://megaflix.lat/");

  const apiUrl = `${base}/player/index.php?data=${id}&do=getVideo`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": embedUrl,
      "Origin": base,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return "";
  const text = await res.text();
  if (!text.trimStart().startsWith("{")) return "";
  const json = JSON.parse(text);
  return json.securedLink || json.videoSource || json.src || "";
}

// ── Extratores ────────────────────────────────────────────────────────────────

async function extractVoltz(url: string): Promise<string | null> {
  function parse(html: string): string | null {
    const m = html.match(/const\s+stream\s*=\s*["']([^"']+)["']/);
    if (m?.[1]?.startsWith("http")) return m[1];
    return findM3u8(html) || html.match(/https?:\/\/[^\s<>"']+\.(mp4|m3u8)[^\s<>"']*/i)?.[0] || null;
  }
  const html = await fetchHtml(url, "https://megaflix.lat/");
  const first = parse(html);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 1200));
  const html2 = await fetchHtml(url, "https://megaflix.lat/");
  return parse(html2);
}

// Decoder direto de Dean Edwards packer — pura análise de string, zero execução de JS.
// Elimina a dependência de vm.runInContext (que falha com regex inválida no packer do PlayHide)
// e de moon.php (que leva ~7s). Cobre o formato padrão:
//   eval(function(p,a,c,k,e,d){...}('packed', base, n, 'w1|w2'.split('|'), 0, {}))
function directDecodePacker(script: string): string | null {
  // Extrai packed (aspas simples ou duplas), base e lista de palavras
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
    return (Number.isFinite(i) && i >= 0 && i < words.length && words[i]) ? words[i] : token;
  });
}

// Tenta decodificar o packer em dois estágios antes de cair no moon.php (7s):
//   1. directDecodePacker: parse de string puro — <1ms, sem rede, sem vm
//   2. vm.runInContext: fallback para variantes não-padrão — pode falhar com regex inválida
function unpackPacker(script: string): { decoded: string | null; ms: number; error: string | null; method: string } {
  const t = Date.now();

  // Estágio 1: decode direto (zero overhead)
  const direct = directDecodePacker(script);
  if (direct) return { decoded: direct, ms: Date.now() - t, error: null, method: "direct" };

  // Estágio 2: vm.runInContext (para variantes não-padrão)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createContext, runInContext } = require("vm") as typeof import("vm");
    let decoded: string | null = null;
    runInContext(script, createContext({ eval: (s: string) => { decoded = s; } }), { timeout: 500 });
    return { decoded, ms: Date.now() - t, error: null, method: "vm" };
  } catch (e: any) {
    return { decoded: null, ms: Date.now() - t, error: String(e?.message).slice(0, 60), method: "vm_failed" };
  }
}

function parseDecodedHide(decoded: string, embedUrl: string): string | null {
  // Primary: string-split approach (same as MegaFlix extractor — more robust than regex)
  const linksSplit = decoded.split("var links=")[1];
  if (linksSplit) {
    try {
      const linksJson = linksSplit.split(";")[0].trim();
      const links = JSON.parse(linksJson);
      const src = links.hls3 || links.hls2 || links.hls4 || null;
      if (src) return src.startsWith("http") ? src : new URL(embedUrl).origin + src;
    } catch { /**/ }
  }
  // Fallback: regex (catches space variants like "var links = {")
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

async function extractHide(html: string, embedUrl: string): Promise<string | null> {
  const evalScript = extractEvalScript(html);
  if (!evalScript) {
    xlog("hide/packer", { found: false, htmlLen: html.length, hint: detectHtmlHint(html) });
    return null;
  }
  xlog("hide/packer", { found: true, scriptLen: evalScript.length });

  // Decode local (directDecodePacker → vm.runInContext): zero rede, <2ms.
  // Se encontrar o stream, retorna imediatamente sem chamar moon.php (~7s de RTT economizados).
  const { decoded: vmDecoded, ms: vmMs, error: vmError, method: vmMethod } = unpackPacker(evalScript);
  const vmStream = vmDecoded ? parseDecodedHide(vmDecoded, embedUrl) : null;
  xlog("hide/vm", { ms: vmMs, method: vmMethod, decoded: !!vmDecoded, resultLen: vmDecoded?.length ?? 0, streamFound: !!vmStream, error: vmError });

  if (vmStream) return vmStream;

  // Fallback: moon.php — só chega aqui se o decode local falhar
  // (packer não-padrão ou erro de parsing). moon() já loga timing internamente.
  let decoded: string;
  try {
    decoded = await moon(evalScript);
  } catch {
    return null;
  }

  const moonStream = parseDecodedHide(decoded, embedUrl);
  // Se moon.php funcionou mas o decode local falhou, loga para diagnóstico futuro
  if (moonStream) xlog("hide/moon_only", { vmMethod, note: "local_decode_missed" });
  return moonStream;
}

async function extractWish(html: string, embedUrl: string): Promise<string | null> {
  const parsed = new URL(embedUrl);
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";

  // Método 1: POST à API do player
  if (id) {
    const postT = Date.now();
    try {
      const form = new URLSearchParams({ hash: id, r: "", do: "getVideo" });
      const res = await fetch(embedUrl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": "https://megaflix.lat/",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json) {
          const src =
            json.sources?.[0]?.file ||
            json.source?.[0]?.file ||
            json.videoSource ||
            json.src ||
            null;
          xlog("wish/post", { ms: Date.now() - postT, status: res.status, jsonKeys: Object.keys(json).slice(0, 6).join(","), found: !!src });
          if (src?.startsWith("http")) return src;
        } else {
          xlog("wish/post", { ms: Date.now() - postT, status: res.status, error: "json_null_or_invalid" });
        }
      } else {
        xlog("wish/post", { ms: Date.now() - postT, status: res.status, error: `http_${res.status}` });
      }
    } catch (e: any) {
      const ms = Date.now() - postT;
      const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      xlog("wish/post", { ms, error: isTimeout ? "timeout_10000ms" : String(e?.message).slice(0, 60) });
    }
  }

  // Método 2: m3u8 direto no HTML (regex)
  const direct = findM3u8(html);
  xlog("wish/m3u8_regex", { found: !!direct });
  if (direct) return direct;

  // Método 3: split por [{file:"
  const fileSplit = html.split('[{file:"')[1]?.split('"')[0];
  const fileSplitOk = fileSplit?.startsWith("http") ?? false;
  xlog("wish/file_split", { found: fileSplitOk });
  if (fileSplitOk) return fileSplit!;

  // Método 4: regex JW sources
  const jwMatch = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i);
  const jwOk = !!(jwMatch?.[1]?.startsWith("http"));
  xlog("wish/jw_sources", { found: jwOk });
  if (jwOk) return jwMatch![1];

  // Método 5: "file":"https://...m3u8" no JSON
  const jsonFile = html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i);
  xlog("wish/json_file", { found: !!jsonFile?.[1] });
  if (jsonFile?.[1]) return jsonFile[1];

  // Método 6: fallback packer (pode chamar moon.php se encontrar eval())
  xlog("wish/fallback_hide", { attempt: true, htmlLen: html.length });
  return extractHide(html, embedUrl);
}

async function extractRola(id: string): Promise<string | null> {
  try {
    const src = await postPlayer("https://llanfairpwllgwyngy.com/player/index.php", id);
    return src || null;
  } catch { return null; }
}

async function extractRola3(id: string): Promise<string | null> {
  // Direct POST to embedplayer1.xyz — same approach MegaFlix uses for rola3
  try {
    const form = new URLSearchParams();
    form.append("hash", id);
    form.append("r", "");
    const apiUrl = `https://embedplayer1.xyz/player/index.php?data=${id}&do=getVideo`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `https://embedplayer1.xyz/v/${id}`,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim().startsWith("{")) return null;
    const json = JSON.parse(text);
    return json.videoSource || json.src || null;
  } catch { return null; }
}

async function extractLulu(url: string): Promise<string | null> {
  // MegaFlix approach: fetch HTML from luluvdo → extract packer → moon.php → parse [{ file:"
  try {
    const html = await fetchHtml(url, "https://megaflix.lat/");
    const evalScript = extractEvalScript(html);
    if (!evalScript) return null;
    const decoded = await moon(evalScript);
    // Same parse as MegaFlix: data.split('[{file:"')[1].split('"')[0]
    const src = decoded.split('[{file:"')[1]?.split('"')[0] ?? null;
    if (src?.startsWith("http")) return src;
    // Fallback: JW sources or m3u8 regex
    return findM3u8(decoded);
  } catch { return null; }
}

async function extractBolt(html: string): Promise<string | null> {
  const src = html.split('[{file:"')[1]?.split('"')[0];
  return src?.startsWith("http") ? src : null;
}

async function extractBig(html: string): Promise<string | null> {
  const src = html.split("url: '")[1]?.split("'")[0];
  return src?.startsWith("http") ? src : null;
}

// ── Webcine: webcinevs2.com ───────────────────────────────────────────────────
// Pipeline: refresh JWT → search by title → verify tmdb_id → find episodeId
//           → get videos → get encrypted URL → resolve-url → follow redirect

let webcineTokenCache: { token: string; expiresAt: number } | null = null;

async function getWebcineToken(): Promise<string> {
  if (webcineTokenCache && Date.now() < webcineTokenCache.expiresAt - 300_000) {
    return webcineTokenCache.token;
  }
  const refreshToken = process.env.WEBCINE_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("WEBCINE_REFRESH_TOKEN not set");
  const deviceId = process.env.WEBCINE_DEVICE_ID ?? "";

  const res = await fetch("https://webcinevs2.com/api/auth/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-device-id": deviceId,
      "User-Agent": UA,
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`webcine refresh HTTP ${res.status}`);
  const data = await res.json();
  const token = data.token as string;
  if (!token) throw new Error("webcine refresh: no token");

  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    webcineTokenCache = { token, expiresAt: (payload.exp as number) * 1000 };
  } catch {
    webcineTokenCache = { token, expiresAt: Date.now() + 25 * 24 * 60 * 60 * 1000 };
  }
  return token;
}

async function extractWebcine(parsed: URL): Promise<{ streamUrl: string; referer: string } | null> {
  const tmdbId = parsed.searchParams.get("id") ?? "";
  const type = parsed.searchParams.get("type") ?? "tv";
  const season = parseInt(parsed.searchParams.get("season") ?? "1", 10);
  const episode = parseInt(parsed.searchParams.get("episode") ?? "1", 10);
  const titleHint = parsed.searchParams.get("q") ?? "";
  const isMovie = type === "movie";

  if (!tmdbId) return null;

  const t0 = Date.now();
  const deviceId = process.env.WEBCINE_DEVICE_ID ?? "";
  const profileId = process.env.WEBCINE_PROFILE_ID ?? "";

  const apiHeaders = (token: string) => ({
    "Authorization": `Bearer ${token}`,
    "x-device-id": deviceId,
    "Accept": "application/json",
    "User-Agent": UA,
  });

  try {
    const token = await getWebcineToken();

    // 1. Search and find internal ID — filter by type to avoid wrong endpoint calls
    const searchQ = titleHint || tmdbId;
    const searchRes = await fetch(
      `https://webcinevs2.com/api/search?q=${encodeURIComponent(searchQ)}`,
      { headers: apiHeaders(token), signal: AbortSignal.timeout(8000) },
    );
    if (!searchRes.ok) {
      xlog("webcine/search_err", { ms: Date.now() - t0, status: searchRes.status });
      return null;
    }
    const candidates = ((await searchRes.json()).data ?? []) as Array<{ id: number; title: string; type: string }>;

    let internalId: number | null = null;
    let episodeId: number | null = null;

    for (const c of candidates.slice(0, 6)) {
      // "movie" → /api/movies/{id}   |   "series"/"anime" → /api/series/{id}
      const cIsMovie = c.type === "movie";
      if (isMovie !== cIsMovie) continue;

      const endpoint = isMovie ? "movies" : "series";
      const detailRes = await fetch(
        `https://webcinevs2.com/api/${endpoint}/${c.id}?profile_id=${profileId}`,
        { headers: apiHeaders(token), signal: AbortSignal.timeout(8000) },
      );
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      if (String(detail.tmdb_id) !== String(tmdbId)) continue;

      internalId = c.id;

      if (!isMovie) {
        // Series: find episodeId from seasons array embedded in detail response
        const seasons = (detail.seasons ?? []) as Array<{
          number: number;
          episodes: Array<{ id: number; number: number }>;
        }>;
        const ep = seasons.find((s) => s.number === season)?.episodes.find((e) => e.number === episode);
        if (ep) episodeId = ep.id;
      }
      break;
    }

    if (!internalId || (!isMovie && !episodeId)) {
      xlog("webcine/not_found", { ms: Date.now() - t0, tmdbId, type, season: isMovie ? null : season, episode: isMovie ? null : episode });
      return null;
    }
    xlog("webcine/found", { ms: Date.now() - t0, tmdbId, internalId, episodeId: episodeId ?? "–", type });

    // 2. Get video list
    // Series: needs profile_id  |  Movie: no profile_id (from HAR)
    const videosUrl = isMovie
      ? `https://webcinevs2.com/api/streaming/movies/${internalId}/videos?platform=web&device_type=web`
      : `https://webcinevs2.com/api/streaming/episodes/${episodeId}/videos?platform=web&device_type=web&profile_id=${profileId}`;

    const videosRes = await fetch(videosUrl, { headers: apiHeaders(token), signal: AbortSignal.timeout(8000) });
    if (!videosRes.ok) {
      xlog("webcine/videos_err", { ms: Date.now() - t0, status: videosRes.status });
      return null;
    }
    const videosData = await videosRes.json();
    if (!videosData.has_subscription) {
      xlog("webcine/no_sub", { ms: Date.now() - t0 });
      return null;
    }
    const videos = (videosData.videos ?? []) as Array<{ id: number; audio_type: string; is_premium: boolean; locked: boolean }>;
    const bestVideo = videos.find((v) => !v.is_premium && !v.locked) ?? videos[0];
    if (!bestVideo) return null;
    xlog("webcine/video_sel", { ms: Date.now() - t0, videoId: bestVideo.id, audio: bestVideo.audio_type });

    // 3. Get encrypted video URL
    // Movie params from HAR: device_id, profile_id, device_name=Windows+(Web), device_type, platform
    // Series params:         platform, device_type, profile_id, device_id
    const videoDetailUrl = isMovie
      ? `https://webcinevs2.com/api/streaming/movies/${internalId}/video/${bestVideo.id}?device_id=${deviceId}&profile_id=${profileId}&device_name=Windows+(Web)&device_type=web&platform=web`
      : `https://webcinevs2.com/api/streaming/episodes/${episodeId}/video/${bestVideo.id}?platform=web&device_type=web&profile_id=${profileId}&device_id=${deviceId}`;

    const videoDetailRes = await fetch(videoDetailUrl, { headers: apiHeaders(token), signal: AbortSignal.timeout(8000) });
    if (!videoDetailRes.ok) {
      xlog("webcine/video_detail_err", { ms: Date.now() - t0, status: videoDetailRes.status });
      return null;
    }
    const { video_url: encryptedUrl, session_id: sessionId } = await videoDetailRes.json();
    if (!encryptedUrl || !sessionId) return null;

    // 4. Resolve URL
    // Movie body (from HAR): {payload, session_id} only
    // Series body: {payload, session_id, device_id, platform, device_type}
    const resolveBody = isMovie
      ? { payload: encryptedUrl, session_id: sessionId }
      : { payload: encryptedUrl, session_id: sessionId, device_id: deviceId, platform: "web", device_type: "web" };

    const resolveRes = await fetch("https://webcinevs2.com/api/streaming/resolve-url", {
      method: "POST",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(resolveBody),
      signal: AbortSignal.timeout(8000),
    });
    if (!resolveRes.ok) {
      xlog("webcine/resolve_err", { ms: Date.now() - t0, status: resolveRes.status });
      return null;
    }
    const rawUrl = (await resolveRes.json()).url as string;
    if (!rawUrl) return null;

    // 5. Follow redirect (server-amz/utx → play-amz/utx)
    let finalUrl = rawUrl;
    try {
      const headRes = await fetch(rawUrl, {
        method: "HEAD",
        headers: { "User-Agent": UA, "Referer": "https://webcinevs2.com/" },
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      const loc = headRes.headers.get("location");
      if (loc && (headRes.status === 301 || headRes.status === 302)) finalUrl = loc;
    } catch { /* use rawUrl as-is */ }

    xlog("webcine/ok", { ms: Date.now() - t0, tmdbId, type, host: (() => { try { return new URL(finalUrl).hostname; } catch { return "?"; } })() });
    return { streamUrl: finalUrl, referer: "https://webcinevs2.com/" };

  } catch (e: any) {
    xlog("webcine/error", { ms: Date.now() - t0, tmdbId, err: String(e?.message ?? "").slice(0, 80) });
    return null;
  }
}

// ── PlayerFlix: playerflix.ink → embedplayer2.xyz ─────────────────────────────
// Pipeline: GET ajax.php (base64 embeds) → decode → POST getVideo → securedLink
// Logging: resolution time, server, hash, expires, HLS URL, failure reason.
async function extractPlayerflix(parsed: URL): Promise<{ streamUrl: string; referer: string; manifest?: string } | null> {
  const tmdbId = parsed.searchParams.get("id") ?? "";
  const type = parsed.searchParams.get("type") ?? "tv";
  const season = parsed.searchParams.get("season") ?? "1";
  const episode = parsed.searchParams.get("episode") ?? "1";
  const t0 = Date.now();

  const ajaxUrl = type === "tv"
    ? `https://playerflix.ink/pages/ajax.php?id=${encodeURIComponent(tmdbId)}&type=tv&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}`
    : `https://playerflix.ink/pages/ajax.php?id=${encodeURIComponent(tmdbId)}&type=movie`;

  // 1. Fetch embed options from playerflix
  let html: string;
  try {
    const res = await fetch(ajaxUrl, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.5",
        "Referer": "https://myembed.biz/",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      xlog("playerflix/ajax", { ms: Date.now() - t0, status: res.status, id: tmdbId, type, error: `http_${res.status}` });
      return null;
    }
    html = await res.text();
  } catch (e: any) {
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    xlog("playerflix/ajax", { ms: Date.now() - t0, id: tmdbId, type, error: isTimeout ? "timeout_8000ms" : String(e?.message ?? "").slice(0, 60) });
    return null;
  }

  // 2. Extract and decode base64 data-embed attributes
  const embedMatches = [...html.matchAll(/data-embed=["']([^"']+)["']/g)];
  const embeds = embedMatches.map((m) => {
    try { return Buffer.from(m[1], "base64").toString("utf-8"); } catch { return null; }
  }).filter(Boolean) as string[];

  xlog("playerflix/embeds", { ms: Date.now() - t0, id: tmdbId, type, total: embedMatches.length, decoded: embeds.length });

  if (embeds.length === 0) {
    xlog("playerflix/no_embeds", { ms: Date.now() - t0, id: tmdbId, type, htmlLen: html.length, failReason: "no_data_embed_found" });
    return null;
  }

  // 3. Prioritize embedplayer2.xyz, fallback to qualquer servidor com /video/{hash}
  let targetUrl = embeds.find((u) => u.includes("embedplayer2.xyz"))
    ?? embeds.find((u) => u.includes("embedplayer"))
    ?? embeds.find((u) => /\/video\/[a-f0-9]{16,}/i.test(u))
    ?? null;
  let server = "embedplayer2.xyz";
  if (targetUrl) {
    try { server = new URL(targetUrl).hostname; } catch { server = "unknown"; }
  }

  if (!targetUrl) {
    const hosts = embeds.map((u) => { try { return new URL(u).hostname; } catch { return "?"; } }).join(",");
    xlog("playerflix/no_ep2", { ms: Date.now() - t0, id: tmdbId, type, embedHosts: hosts.slice(0, 100), failReason: "no_embedplayer_found" });
    return null;
  }

  // 4. Extract hash from /video/{hash}
  const hashMatch = targetUrl.match(/\/video\/([a-f0-9]{16,})/i);
  const hash = hashMatch?.[1] ?? "";
  if (!hash) {
    xlog("playerflix/no_hash", { ms: Date.now() - t0, server, failReason: "hash_not_found_in_url" });
    return null;
  }

  xlog("playerflix/getVideo", { server, hash });

  // 5. POST to getVideo
  const form = new URLSearchParams();
  form.append("hash", hash);
  form.append("r", "");

  let data: Record<string, unknown>;
  try {
    const r2 = await fetch(`https://${server}/player/index.php?data=${hash}&do=getVideo`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `https://${server}/video/${hash}`,
        "Origin": `https://${server}`,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!r2.ok) {
      xlog("playerflix/result", { ms: Date.now() - t0, server, hash, status: r2.status, found: false, failReason: `http_${r2.status}` });
      return null;
    }
    const text = await r2.text();
    data = JSON.parse(text);
  } catch (e: any) {
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    xlog("playerflix/result", { ms: Date.now() - t0, server, hash, found: false, failReason: isTimeout ? "timeout_8000ms" : String(e?.message ?? "").slice(0, 60) });
    return null;
  }

  const securedLink = data.securedLink as string | undefined;
  const videoSource = data.videoSource as string | undefined;
  const streamUrl = securedLink || videoSource || null;

  let expires: number | null = null;
  if (securedLink) {
    try { expires = Number(new URLSearchParams(securedLink.split("?")[1]).get("expires")); } catch { /**/ }
  }

  xlog("playerflix/result", {
    ms: Date.now() - t0,
    server,
    hash,
    expires,
    hls: !!securedLink,
    found: !!streamUrl,
    failReason: streamUrl ? null : "securedLink_and_videoSource_empty",
  });

  if (!streamUrl) return null;

  // Busca o manifest agora, na mesma instância/IP que gerou o securedLink.
  // O CDN usa IP-bound md5 — o proxy rodaria em IP diferente e levaria 403.
  const embedReferer = `https://${server}/video/${hash}`;
  let manifest: string | undefined;
  try {
    const mRes = await fetch(streamUrl, {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Referer": embedReferer,
        "Origin": `https://${server}`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (mRes.ok) {
      const ct = mRes.headers.get("content-type") ?? "";
      if (ct.includes("mpegurl") || ct.includes("text") || mRes.url.includes(".m3u8") || mRes.url.includes(".txt")) {
        manifest = await mRes.text();
        xlog("playerflix/manifest", { ms: Date.now() - t0, server, hash, bytes: manifest.length, finalUrl: mRes.url.slice(0, 80) });
      }
    } else {
      xlog("playerflix/manifest_err", { ms: Date.now() - t0, server, hash, status: mRes.status });
    }
  } catch (e: any) {
    xlog("playerflix/manifest_err", { ms: Date.now() - t0, server, hash, err: String(e?.message ?? "").slice(0, 60) });
  }

  return { streamUrl, referer: embedReferer, manifest };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractEvalScript(html: string): string | null {
  const idx = html.indexOf("eval(function(p,a,c,k,e,d)");
  if (idx === -1) return null;
  const chunk = html.slice(idx, idx + 50000);
  // Try to find exact packer end
  const endIdx = chunk.search(/\.split\('\|'\)\s*,\s*0\s*,\s*\{\s*\}\s*\)\s*\)/);
  if (endIdx !== -1) return chunk.slice(0, endIdx + 30);
  // Fallback: cut at </script> (same approach the MegaFlix extractor uses)
  const scriptEnd = chunk.indexOf("</script>");
  if (scriptEnd !== -1) return chunk.slice(0, scriptEnd);
  return chunk;
}

function findM3u8(text: string): string | null {
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

// ── Router principal ──────────────────────────────────────────────────────────

const EXTRACT_TIMEOUT_MS = 25000;

async function doExtract(url: string): Promise<{ stream: string; tipo: string; referer?: string; manifest?: string }> {
  const parsed = await assertSafeUrl(url);
  const hostname = parsed.hostname;
  const pathname = parsed.pathname;
  const id = pathname.split("/").filter(Boolean).pop() ?? "";

  let streamUrl: string | null = null;
  let referer: string | undefined;
  let manifest: string | undefined;

  if (pathname.includes("vast.php")) {
    const linkParam = parsed.searchParams.get("link");
    if (!linkParam) return { stream: url, tipo: "iframe" };
    const innerUrl = Buffer.from(linkParam, "base64").toString("utf-8");
    return doExtract(innerUrl);
  }

  if (hostname.includes("voltz.php") || pathname.includes("voltz.php")) {
    streamUrl = await extractVoltz(url);

  } else if (hostname.includes("lulu") || hostname.includes("luluvdo")) {
    const t = Date.now();
    xlog("lulu/start", { id, hostname });
    try {
      streamUrl = await extractLulu(url);
    } finally {
      xlog("lulu/total", { ms: Date.now() - t, found: !!streamUrl });
    }

  } else if (hostname.includes("hide") || hostname.includes("playhide")) {
    const t = Date.now();
    xlog("hide/start", { id, hostname });
    try {
      const html = await fetchHtmlDiag("hide", `https://playhide.shop/v/${id}`, "https://megaflix.lat/");
      streamUrl = await extractHide(html, url);
      referer = `https://playhide.shop/v/${id}`;
    } finally {
      xlog("hide/total", { ms: Date.now() - t, found: !!streamUrl });
    }

  } else if (hostname.includes("wish") || hostname.includes("hlswish") || hostname.includes("streamwish") || hostname.includes("playerwish")) {
    const t = Date.now();
    xlog("wish/start", { id, hostname });
    try {
      const html = await fetchHtmlDiag("wish", url, "https://megaflix.lat/");
      streamUrl = await extractWish(html, url);
    } finally {
      xlog("wish/total", { ms: Date.now() - t, found: !!streamUrl });
    }

  } else if (
    pathname.includes("/rola4/") ||
    pathname.includes("/rola3/") ||
    hostname.includes("embedplayer") ||
    hostname.includes("rola3")
  ) {
    // Direct extraction via embedplayer1.xyz (same as MegaFlix rola3 approach)
    const t = Date.now();
    xlog("rola3/start", { id, hostname });
    streamUrl = await extractRola3(id);
    xlog("rola3/total", { ms: Date.now() - t, found: !!streamUrl });

    // Fallback: worker URL if direct extraction failed
    if (!streamUrl) {
      const workerUrl = process.env.EMBED_WORKER_URL;
      if (workerUrl) {
        streamUrl = `${workerUrl}/stream?embedUrl=${encodeURIComponent(url)}`;
      }
    }

  } else if (hostname.includes("rola") || hostname.includes("llanfair")) {
    streamUrl = await extractRola(id);

  } else if (hostname.includes("bolt")) {
    const html = await fetchHtml(url, "https://megaflix.lat/");
    streamUrl = await extractBolt(html);

  } else if (hostname.includes("big") || hostname.includes("bigshare")) {
    const html = await fetchHtml(url, "https://megaflix.lat/");
    streamUrl = await extractBig(html);

  } else if (hostname.includes("playerflix.ink")) {
    const t = Date.now();
    xlog("playerflix/start", { id: parsed.searchParams.get("id") ?? "", type: parsed.searchParams.get("type") ?? "tv", season: parsed.searchParams.get("season") ?? "", episode: parsed.searchParams.get("episode") ?? "" });
    const pfResult = await extractPlayerflix(parsed);
    streamUrl = pfResult?.streamUrl ?? null;
    if (pfResult?.referer) referer = pfResult.referer;
    if (pfResult?.manifest) manifest = pfResult.manifest;
    xlog("playerflix/total", { ms: Date.now() - t, found: !!streamUrl, manifestBytes: pfResult?.manifest?.length ?? 0 });

  } else if (hostname.includes("webcinevs2.com")) {
    const t = Date.now();
    xlog("webcine/start", { id: parsed.searchParams.get("id") ?? "", type: parsed.searchParams.get("type") ?? "tv", season: parsed.searchParams.get("season") ?? "", episode: parsed.searchParams.get("episode") ?? "" });
    const wcResult = await extractWebcine(parsed);
    streamUrl = wcResult?.streamUrl ?? null;
    if (wcResult?.referer) referer = wcResult.referer;
    xlog("webcine/total", { ms: Date.now() - t, found: !!streamUrl });

  } else {
    const html = await fetchHtml(url, "https://megaflix.lat/");
    const evalScript = extractEvalScript(html);
    if (evalScript) {
      try {
        const decoded = await moon(evalScript);
        streamUrl = findM3u8(decoded) || decoded.split('[{file:"')[1]?.split('"')[0] || null;
      } catch { /**/ }
    }
    if (!streamUrl) streamUrl = findM3u8(html);
  }

  if (!streamUrl) return { stream: url, tipo: "iframe" };

  const tipo = streamUrl.includes(".mp4") ? "mp4" : "hls";
  return { stream: streamUrl, tipo, referer, manifest };
}

export async function GET(req: NextRequest) {
  const ip = clientIp(req);
  const ua = clientUa(req);

  if (await isIpBlocked(ip)) {
    audit("ip_blocked", { ip, ua, detail: "bloqueado em /extract" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 429, headers: NO_STORE });
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !origin.includes(host)) {
    await recordAbuseAttempt(ip);
    audit("origin_rejected", { ip, ua, detail: `origin=${origin}` });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    await recordAbuseAttempt(ip);
    audit("auth_failure", { ip, ua, detail: "/extract sem sessão" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });
  }

  const userId = (session.user as { id: string }).id;
  if (!userId) return NextResponse.json({ error: "Acesso negado" }, { status: 401, headers: NO_STORE });

  const url = req.nextUrl.searchParams.get("url");
  const playToken = req.nextUrl.searchParams.get("playToken");

  if (!url || !playToken) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 400, headers: NO_STORE });
  }

  const tokenCheck = verifyPlayToken(playToken, userId, url, ip);
  if (!tokenCheck.ok) {
    await recordAbuseAttempt(ip);
    audit("play_token_rejected", { userId, ip, ua, detail: "token inválido ou expirado" });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403, headers: NO_STORE });
  }
  if (tokenCheck.ipMismatch) {
    audit("play_token_rejected", { userId, ip, ua, detail: "IP mismatch (rede móvel — permitido)" });
  }

  try {
    const result = await Promise.race([
      doExtract(url),
      new Promise<{ stream: string; tipo: string; referer?: string; manifest?: string }>((resolve) =>
        setTimeout(() => resolve({ stream: url, tipo: "iframe" }), EXTRACT_TIMEOUT_MS)
      ),
    ]);

    if (result.tipo === "iframe") {
      return NextResponse.json({ tipo: "iframe", stream: result.stream }, { headers: NO_STORE });
    }

    // MP4: stream token is single-use (SET NX) — JW Player makes multiple range requests
    // when seeking, so the second request always fails with "token já consumido".
    // Use a HMAC-signed proxy URL instead; it's stateless and allows repeated range requests.
    if (result.tipo === "mp4") {
      const sig = signSegmentUrl(result.stream, userId);
      const ref = result.referer ? `&ref=${encodeURIComponent(result.referer)}` : "";
      const proxyUrl = `/api/player/proxy?url=${encodeURIComponent(result.stream)}&sig=${sig}${ref}`;
      return NextResponse.json({ tipo: "mp4", streamToken: proxyUrl }, { headers: NO_STORE });
    }

    const { token: streamToken, accepted } = await createStreamToken(
      userId,
      result.stream,
      result.referer ?? null,
      ip,
      ua,
      result.manifest,
    );

    if (!accepted) {
      return NextResponse.json({ error: "Limite de reproduções simultâneas atingido" }, { status: 429, headers: NO_STORE });
    }

    return NextResponse.json({ tipo: result.tipo, streamToken }, { headers: NO_STORE });

  } catch (err: any) {
    audit("stream_rejected", { userId, ip, ua, detail: `extração falhou: ${String(err?.message).slice(0, 80)}` });
    return NextResponse.json({ tipo: "iframe", stream: url }, { headers: NO_STORE });
  }
}
