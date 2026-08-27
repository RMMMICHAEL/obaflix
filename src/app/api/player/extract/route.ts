export const dynamic = "force-dynamic";
export const maxDuration = 60;
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertAllowedMediaUrl } from "@/lib/mediaProviders";
import { ehHostHide, ordemEspelhosHide, validarMasterHide } from "@/lib/hideMaster";
import { extractCineVs, type CineVsFonte, type CineVsSubtitle } from "@/lib/cinevs";
import { headerMatchesHost } from "@/lib/requestSecurity";
import { parsePlayerflixEmbeds } from "@/lib/playerflix";
import {
  verifyPlayToken,
  createStreamToken,
  signSegmentUrl,
  isIpBlocked,
  recordAbuseAttempt,
} from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";
import {
  resolverFonte, acrescentarFontes, projetarPublica, type FontePublica,
} from "@/lib/fontes";
import crypto from "crypto";

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

function signedWorkerStreamUrl(workerBase: string, embedUrl: string): string | null {
  const secret = process.env.EMBED_WORKER_SECRET;
  if (!secret || secret.length < 32) return null;
  const target = new URL("/stream", workerBase);
  target.searchParams.set("embedUrl", embedUrl);
  const exp = String(Math.floor(Date.now() / 1000) + 10 * 60);
  target.searchParams.set("exp", exp);
  const canonical = `/stream\n${exp}\n${target.searchParams.toString()}`;
  const sig = crypto.createHmac("sha256", secret).update(canonical).digest("base64url");
  target.searchParams.set("sig", sig);
  return target.toString();
}

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

/**
 * `paginaHide` é a página do espelho que **realmente respondeu**, não a URL
 * recebida: quando o fallback sai de playhide.shop (morto) para hidehide.shop,
 * resolver um caminho relativo contra a URL original monta a mídia sobre um
 * domínio que não existe mais.
 */
function parseDecodedHide(decoded: string, paginaHide: string): string | null {
  // Primary: string-split approach (same as MegaFlix extractor — more robust than regex)
  const linksSplit = decoded.split("var links=")[1];
  if (linksSplit) {
    try {
      const linksJson = linksSplit.split(";")[0].trim();
      const links = JSON.parse(linksJson);
      const src = links.hls3 || links.hls2 || links.hls4 || null;
      if (src) return src.startsWith("http") ? src : new URL(paginaHide).origin + src;
    } catch { /**/ }
  }
  // Fallback: regex (catches space variants like "var links = {")
  const linksMatch = decoded.match(/var\s+links\s*=\s*(\{[^;]+\})/);
  if (linksMatch) {
    try {
      const links = JSON.parse(linksMatch[1]);
      const src = links.hls3 || links.hls2 || links.hls4 || null;
      if (src) return src.startsWith("http") ? src : new URL(paginaHide).origin + src;
    } catch { /**/ }
  }
  return findM3u8(decoded);
}

async function extractHide(html: string, paginaHide: string): Promise<string | null> {
  const evalScript = extractEvalScript(html);
  if (!evalScript) {
    xlog("hide/packer", { found: false, htmlLen: html.length, hint: detectHtmlHint(html) });
    return null;
  }
  xlog("hide/packer", { found: true, scriptLen: evalScript.length });

  // Decode local (directDecodePacker → vm.runInContext): zero rede, <2ms.
  // Se encontrar o stream, retorna imediatamente sem chamar moon.php (~7s de RTT economizados).
  const { decoded: vmDecoded, ms: vmMs, error: vmError, method: vmMethod } = unpackPacker(evalScript);
  const vmStream = vmDecoded ? parseDecodedHide(vmDecoded, paginaHide) : null;
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

  const moonStream = parseDecodedHide(decoded, paginaHide);
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
    const videos = (videosData.videos ?? []) as Array<{ id: number; audio_type: string; is_premium: boolean; locked: boolean; sort_order?: number }>;
    if (videos.length === 0) return null;

    // Prioridade: dubbed desbloqueados (na ordem da lista) → subtitled → premium (último recurso)
    const eligible = [
      ...videos.filter((v) => !v.is_premium && !v.locked && v.audio_type === "dubbed"),
      ...videos.filter((v) => !v.is_premium && !v.locked && v.audio_type !== "dubbed"),
      ...videos.filter((v) => v.is_premium || v.locked),
    ];
    if (eligible.length === 0) eligible.push(videos[0]);

    // Tenta cada servidor em ordem; avança se resolve falhar ou HEAD retornar 4xx/5xx
    for (const video of eligible) {
      xlog("webcine/video_try", { ms: Date.now() - t0, videoId: video.id, audio: video.audio_type });

      // 3. Encrypted video URL
      const videoDetailUrl = isMovie
        ? `https://webcinevs2.com/api/streaming/movies/${internalId}/video/${video.id}?device_id=${deviceId}&profile_id=${profileId}&device_name=Windows+(Web)&device_type=web&platform=web`
        : `https://webcinevs2.com/api/streaming/episodes/${episodeId}/video/${video.id}?platform=web&device_type=web&profile_id=${profileId}&device_id=${deviceId}`;

      let encryptedUrl: string, sessionId: number;
      try {
        const r = await fetch(videoDetailUrl, { headers: apiHeaders(token), signal: AbortSignal.timeout(8000) });
        if (!r.ok) { xlog("webcine/detail_skip", { videoId: video.id, status: r.status }); continue; }
        const d = await r.json();
        encryptedUrl = d.video_url; sessionId = d.session_id;
        if (!encryptedUrl || !sessionId) continue;
      } catch { continue; }

      // 4. Resolve URL
      const resolveBody = isMovie
        ? { payload: encryptedUrl, session_id: sessionId }
        : { payload: encryptedUrl, session_id: sessionId, device_id: deviceId, platform: "web", device_type: "web" };

      let rawUrl: string;
      try {
        const r = await fetch("https://webcinevs2.com/api/streaming/resolve-url", {
          method: "POST",
          headers: { ...apiHeaders(token), "Content-Type": "application/json" },
          body: JSON.stringify(resolveBody),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) { xlog("webcine/resolve_skip", { videoId: video.id, status: r.status }); continue; }
        rawUrl = (await r.json()).url;
        if (!rawUrl) continue;
      } catch { continue; }

      // 5. HEAD check — valida servidor e segue redirect; rejeita 4xx/5xx
      let finalUrl = rawUrl;
      try {
        const headRes = await fetch(rawUrl, {
          method: "HEAD",
          headers: { "User-Agent": UA, "Referer": "https://webcinevs2.com/" },
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        });
        if (headRes.status >= 400) {
          xlog("webcine/head_skip", { videoId: video.id, status: headRes.status });
          continue;
        }
        const loc = headRes.headers.get("location");
        if (loc && (headRes.status === 301 || headRes.status === 302)) finalUrl = loc;
      } catch { /* erro de rede no HEAD — tenta usar rawUrl mesmo assim */ }

      const host = (() => { try { return new URL(finalUrl).hostname; } catch { return "?"; } })();
      xlog("webcine/ok", { ms: Date.now() - t0, tmdbId, type, videoId: video.id, audio: video.audio_type, host });
      return { streamUrl: finalUrl, referer: "https://webcinevs2.com/" };
    }

    xlog("webcine/all_failed", { ms: Date.now() - t0, tmdbId, tried: eligible.length });
    return null;

  } catch (e: any) {
    xlog("webcine/error", { ms: Date.now() - t0, tmdbId, err: String(e?.message ?? "").slice(0, 80) });
    return null;
  }
}

// ── WatchPlay ─────────────────────────────────────────────────────────────────
// O PlayerFlix atualmente devolve WatchPlay como a primeira opção para filmes e
// séries. Este extrator já existia nos clientes nativos; a versão web precisa do
// mesmo caminho para não depender de uma opção EmbedPlayer que deixou de vir na API.
async function extractWatchplayer(embedUrl: string): Promise<string | null> {
  const parsed = await assertAllowedMediaUrl(embedUrl);
  if (parsed.hostname !== "v1.watchplay.shop") return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const html = await fetchHtml(embedUrl, "https://playerflix.ink/");
  const tags = html.match(/<[^>]+>/g) ?? [];
  const attr = (tag: string, name: string): string | null => {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
    return match?.[1] ?? null;
  };

  const callApi = async (params: Record<string, string>): Promise<any> => {
    const body = new URLSearchParams(params);
    const response = await fetch("https://v1.watchplay.shop/api", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": embedUrl,
        "Origin": "https://v1.watchplay.shop",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`WatchPlay API HTTP ${response.status}`);
    return response.json();
  };

  let videoId: string | null = null;
  if (parts[0] === "tvshow") {
    const season = parts[2];
    const episode = parts[3];
    if (!season || !episode) return null;

    const episodeTag = tags.find((tag) =>
      attr(tag, "data-season") === season && attr(tag, "data-episode") === episode,
    );
    const contentId = episodeTag ? attr(episodeTag, "data-contentid") : null;
    if (!contentId) return null;

    const optionsJson = await callApi({ action: "getOptions", contentid: contentId });
    const firstOption = optionsJson?.data?.options?.[0];
    videoId = typeof firstOption?.ID === "string" || typeof firstOption?.ID === "number"
      ? String(firstOption.ID)
      : null;
  } else {
    const playerTag = tags.find((tag) => {
      const classes = attr(tag, "class")?.split(/\s+/) ?? [];
      return classes.includes("player_select_item") && !!attr(tag, "data-id");
    });
    videoId = playerTag ? attr(playerTag, "data-id") : null;
  }

  if (!videoId) return null;
  const playerJson = await callApi({ action: "getPlayer", video_id: videoId });
  const streamUrl = playerJson?.data?.video_url;
  return typeof streamUrl === "string" && /^https:\/\//i.test(streamUrl) ? streamUrl : null;
}

// ── PlayerFlix: playerflix.ink → WatchPlay/EmbedPlayer ────────────────────────
// Pipeline atual: GET inc/Ajax.php (JSON options) → WatchPlay getPlayer.
// O fluxo legado de EmbedPlayer continua como fallback.
// The parser retains support for the former pages/ajax.php HTML response.
// Logging: resolution time, server, hash, expires, HLS URL, failure reason.
async function extractPlayerflix(parsed: URL): Promise<{ streamUrl: string; referer: string; manifest?: string } | null> {
  const tmdbId = parsed.searchParams.get("id") ?? "";
  const type = parsed.searchParams.get("type") ?? "tv";
  const season = parsed.searchParams.get("season") ?? "1";
  const episode = parsed.searchParams.get("episode") ?? "1";
  const t0 = Date.now();

  const ajaxUrl = new URL("https://playerflix.ink/inc/Ajax.php");
  ajaxUrl.searchParams.set("type", type === "tv" ? "tv" : "movie");
  ajaxUrl.searchParams.set("id", tmdbId);
  if (type === "tv") {
    ajaxUrl.searchParams.set("season", season);
    ajaxUrl.searchParams.set("episode", episode);
  }
  const pageReferer = type === "tv"
    ? `https://playerflix.ink/serie/${encodeURIComponent(tmdbId)}/${encodeURIComponent(season)}/${encodeURIComponent(episode)}`
    : `https://playerflix.ink/filme/${encodeURIComponent(tmdbId)}`;

  // 1. Fetch embed options from playerflix
  let responseBody: string;
  try {
    const res = await fetch(ajaxUrl, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "pt-BR,pt;q=0.5",
        "Referer": pageReferer,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      xlog("playerflix/ajax", { ms: Date.now() - t0, status: res.status, id: tmdbId, type, error: `http_${res.status}` });
      return null;
    }
    responseBody = await res.text();
  } catch (e: any) {
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    xlog("playerflix/ajax", { ms: Date.now() - t0, id: tmdbId, type, error: isTimeout ? "timeout_8000ms" : String(e?.message ?? "").slice(0, 60) });
    return null;
  }

  // 2. Current API returns { status, data: { options: [{ embed }] } }.
  // Keep parsing legacy data-embed HTML so cached/older deployments still work.
  const parsedEmbeds = parsePlayerflixEmbeds(responseBody);
  const embeds = parsedEmbeds.embeds;

  xlog("playerflix/embeds", {
    ms: Date.now() - t0,
    id: tmdbId,
    type,
    format: parsedEmbeds.format,
    total: parsedEmbeds.optionCount,
    decoded: embeds.length,
  });

  if (embeds.length === 0) {
    xlog("playerflix/no_embeds", {
      ms: Date.now() - t0,
      id: tmdbId,
      type,
      format: parsedEmbeds.format,
      bodyLen: responseBody.length,
      failReason: "no_embed_options_found",
    });
    return null;
  }

  // 3. A API atual prioriza WatchPlay. Mantém EmbedPlayer como fallback para
  // respostas antigas, caches e conteúdos cuja lista de servidores seja diferente.
  const watchplayerUrl = embeds.find((candidate) => {
    try { return new URL(candidate).hostname === "v1.watchplay.shop"; } catch { return false; }
  });
  if (watchplayerUrl) {
    try {
      const streamUrl = await extractWatchplayer(watchplayerUrl);
      if (streamUrl) {
        xlog("playerflix/watchplay", { ms: Date.now() - t0, id: tmdbId, type, found: true });
        return { streamUrl, referer: watchplayerUrl };
      }
    } catch (error: any) {
      xlog("playerflix/watchplay", {
        ms: Date.now() - t0,
        id: tmdbId,
        type,
        found: false,
        error: String(error?.message ?? "").slice(0, 80),
      });
    }
  }

  // 4. Prioriza embedplayer2.xyz e aceita o formato legado /video/{hash}.
  const targetUrl = embeds.find((u) => u.includes("embedplayer2.xyz"))
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

  await assertAllowedMediaUrl(targetUrl);

  // 5. Extract hash from /video/{hash}
  const hashMatch = targetUrl.match(/\/video\/([a-f0-9]{16,})/i);
  const hash = hashMatch?.[1] ?? "";
  if (!hash) {
    xlog("playerflix/no_hash", { ms: Date.now() - t0, server, failReason: "hash_not_found_in_url" });
    return null;
  }

  xlog("playerflix/getVideo", { server });

  // 6. POST to getVideo
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
      xlog("playerflix/result", { ms: Date.now() - t0, server, status: r2.status, found: false, failReason: `http_${r2.status}` });
      return null;
    }
    const text = await r2.text();
    data = JSON.parse(text);
  } catch (e: any) {
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    xlog("playerflix/result", { ms: Date.now() - t0, server, found: false, failReason: isTimeout ? "timeout_8000ms" : String(e?.message ?? "").slice(0, 60) });
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
        xlog("playerflix/manifest", { ms: Date.now() - t0, server, bytes: manifest.length });
      }
    } else {
      xlog("playerflix/manifest_err", { ms: Date.now() - t0, server, status: mRes.status });
    }
  } catch (e: any) {
    xlog("playerflix/manifest_err", { ms: Date.now() - t0, server, err: String(e?.message ?? "").slice(0, 60) });
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

/**
 * Por que a extração nativa desistiu.
 *
 * Toda falha aqui termina em `tipo: "iframe"` com HTTP 200 — degradar para o
 * iframe do provedor é melhor que não mostrar nada. O problema era isso ser
 * indistinguível de um sucesso: no DevTools e no logcat, "extraiu o stream" e
 * "desistiu depois de 25s" tinham exatamente a mesma cara. Este campo existe
 * só para diagnóstico; não muda o comportamento.
 */
type MotivoIframe =
  | "sem_link_vast"          // vast.php sem o parâmetro `link`
  | "sem_fonte_extraivel"    // nenhum provider conhecido na lista de embeds
  | "timeout"                // estourou EXTRACT_TIMEOUT_MS
  | "erro";                  // exceção durante a extração

type ResultadoExtracao = {
  stream: string;
  tipo: string;
  referer?: string;
  manifest?: string;
  motivo?: MotivoIframe;
  /** Legendas separadas da faixa de vídeo, quando o provedor oferece. */
  subtitles?: CineVsSubtitle[];
  /** Servidores do mesmo conteúdo, para o menu de troca manual. */
  fontes?: CineVsFonte[];
  /** Fonte usada nesta extração. */
  videoId?: number;
  /** Medido: o CDN aceita origem arbitrária, então a mídia pode ir direto. */
  corsLiberado?: boolean;
};

async function doExtract(url: string): Promise<ResultadoExtracao> {
  const parsed = await assertAllowedMediaUrl(url);
  const hostname = parsed.hostname;
  const pathname = parsed.pathname;
  const id = pathname.split("/").filter(Boolean).pop() ?? "";

  let streamUrl: string | null = null;
  let subtitles: CineVsSubtitle[] | undefined;
  let fontes: CineVsFonte[] | undefined;
  let videoId: number | undefined;
  let corsLiberado = false;
  let referer: string | undefined;
  let manifest: string | undefined;

  if (pathname.includes("vast.php")) {
    const linkParam = parsed.searchParams.get("link");
    if (!linkParam) return { stream: url, tipo: "iframe", motivo: "sem_link_vast" };
    const innerUrl = Buffer.from(linkParam, "base64").toString("utf-8");
    return doExtract(innerUrl);
  }

  if (hostname.includes("voltz.php") || pathname.includes("voltz.php")) {
    streamUrl = await extractVoltz(url);
    if (streamUrl) referer = url; // CDN verifica Referer — usa a página do embed como origem

  } else if (hostname.includes("lulu") || hostname.includes("luluvdo")) {
    const t = Date.now();
    xlog("lulu/start", { id, hostname });
    try {
      streamUrl = await extractLulu(url);
    } finally {
      xlog("lulu/total", { ms: Date.now() - t, found: !!streamUrl });
    }

  } else if (ehHostHide(hostname)) {
    const t = Date.now();
    xlog("hide/start", { id, hostname });
    try {
      // playhide.shop era o host canônico e está morto — não completa o TLS.
      // Como era o único tentado aqui, o provedor inteiro ficava indisponível.
      // O host da URL recebida vem primeiro, seguido dos espelhos vivos.
      const ordem = ordemEspelhosHide(hostname);

      let html: string | null = null;
      // A página do espelho que respondeu: serve de Referer para o CDN e de base
      // para caminhos relativos. A URL recebida pode apontar para um host morto.
      let paginaUsada = url;
      const falhas: string[] = [];
      for (const host of ordem) {
        const pagina = `https://${host}/v/${id}`;
        try {
          html = await fetchHtmlDiag("hide", pagina, "https://megaflix.lat/");
          paginaUsada = pagina;
          referer = pagina;
          if (host !== ordem[0]) xlog("hide/espelho", { host });
          break;
        } catch (e: any) {
          falhas.push(`${host}: ${String(e?.message ?? "").slice(0, 40)}`);
        }
      }
      if (!html) throw new Error(`PlayHide indisponível — ${falhas.join(" | ")}`);
      streamUrl = await extractHide(html, paginaUsada);

      if (streamUrl) {
        const veredito = await validarMasterHide(streamUrl, paginaUsada);
        xlog("hide/master", {
          motivo: veredito.motivo,
          status: veredito.status ?? null,
          inline: veredito.manifest?.length ?? 0,
        });
        if (veredito.removido) {
          streamUrl = null;
          throw new Error("PlayHide não tem mais este arquivo — escolha outro servidor");
        }
        if (veredito.manifest) manifest = veredito.manifest;
      }
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
      if (workerUrl) streamUrl = signedWorkerStreamUrl(workerUrl, url);
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
    const tmdbId = parsed.searchParams.get("id") ?? "";
    const tipoBusca = parsed.searchParams.get("type") ?? "tv";
    xlog("webcine/start", { id: tmdbId, type: tipoBusca, season: parsed.searchParams.get("season") ?? "", episode: parsed.searchParams.get("episode") ?? "" });

    // cinevs fala com a base atual (utxptx-api/api/v1) e faz o resolve-url que o
    // fluxo web exige. extractWebcine aponta para webcinevs2.com/api, que nao
    // responde mais — fica como fallback caso a base volte.
    let usouCineVs = false;
    try {
      // `video` identifica a fonte escolhida no menu. Sem ele, o extrator pega
      // a primeira disponível na ordem do provedor.
      const videoEscolhido = Number(parsed.searchParams.get("video") ?? 0) || undefined;
      const cv = await extractCineVs({
        tmdbId,
        type: tipoBusca === "movie" ? "movie" : "tv",
        season: Number(parsed.searchParams.get("season") ?? 1),
        episode: Number(parsed.searchParams.get("episode") ?? 1),
        titleHint: parsed.searchParams.get("q") ?? "",
        videoId: videoEscolhido,
      });
      if (cv?.streamUrl) {
        streamUrl = cv.streamUrl;
        // null de proposito: o CDN nao exige Referer, e mandar um so atrapalha.
        referer = cv.referer ?? undefined;
        subtitles = cv.subtitles.length ? cv.subtitles : undefined;
        fontes = cv.fontes;
        videoId = cv.videoId;
        corsLiberado = cv.corsLiberado;
        usouCineVs = true;
        xlog("webcine/cinevs", {
          ms: Date.now() - t, host: cv.mediaHost, formato: cv.format,
          subs: cv.subtitles.length, fontes: cv.fontes.length,
          videoId: cv.videoId, cors: cv.corsLiberado ? "liberado" : "restrito",
        });
      }
    } catch (e: any) {
      xlog("webcine/cinevs_err", { err: String(e?.message ?? "").slice(0, 80) });
    }

    if (!usouCineVs) {
      const wcResult = await extractWebcine(parsed);
      streamUrl = wcResult?.streamUrl ?? null;
      if (wcResult?.referer) referer = wcResult.referer;
    }
    xlog("webcine/total", { ms: Date.now() - t, found: !!streamUrl, via: usouCineVs ? "cinevs" : "legado" });

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

  if (!streamUrl) return { stream: url, tipo: "iframe", motivo: "sem_fonte_extraivel" };

  const tipo = streamUrl.includes(".mp4") ? "mp4" : "hls";
  return { stream: streamUrl, tipo, referer, manifest, subtitles, fontes, videoId, corsLiberado };
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
  if (origin && host && !headerMatchesHost(origin, host)) {
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

  // A fonte chega como id opaco. A URL real é resolvida aqui e não volta ao
  // cliente, exceto no iframe de fallback — único caso em que o navegador
  // precisa dela para renderizar alguma coisa.
  const sessao = req.nextUrl.searchParams.get("sessao");
  const fonteId = req.nextUrl.searchParams.get("fonteId");
  const playToken = req.nextUrl.searchParams.get("playToken");

  if (!sessao || !fonteId || !playToken) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 400, headers: NO_STORE });
  }

  const { fonte, motivo } = await resolverFonte(sessao, userId, fonteId);
  if (!fonte) {
    const sessaoMorreu = motivo !== undefined;
    if (!sessaoMorreu) await recordAbuseAttempt(ip);
    audit("play_token_rejected", { userId, ip, ua, detail: `/extract: fonte não resolvida (${motivo ?? "id_desconhecido"})` });
    return NextResponse.json(
      {
        error: sessaoMorreu ? "Sessão de reprodução expirada" : "Fonte indisponível",
        codigo: sessaoMorreu ? "sessao_invalida" : "fonte_desconhecida",
        motivo,
      },
      { status: sessaoMorreu ? 410 : 404, headers: NO_STORE },
    );
  }
  const url = fonte.embedUrl;

  const tokenCheck = await verifyPlayToken(playToken, userId, url, ip);
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
      new Promise<ResultadoExtracao>((resolve) =>
        setTimeout(() => resolve({ stream: url, tipo: "iframe", motivo: "timeout" }), EXTRACT_TIMEOUT_MS)
      ),
    ]);

    if (result.tipo === "iframe") {
      const motivo = result.motivo ?? "sem_fonte_extraivel";
      // Registra a desistência com a mesma visibilidade de um sucesso: antes só
      // o audit log sabia, e o cliente recebia um 200 idêntico ao de um stream.
      xlog("iframe_fallback", { motivo, provider: fonte.provider, fonte: fonte.ordem });
      // Provedores cujo iframe nunca reproduz: o cliente já tratava isso como
      // falha e trocava de fonte. Responder o erro aqui evita mandar a URL do
      // provedor ao navegador para um iframe que não ia funcionar.
      if (fonte.iframeInvalido) {
        return NextResponse.json(
          { error: "Stream não encontrado", motivo },
          { status: 404, headers: NO_STORE },
        );
      }
      return NextResponse.json({ tipo: "iframe", stream: result.stream, motivo }, { headers: NO_STORE });
    }

    // Os servidores do webcine chegam junto da extração (/videos já é buscado
    // lá). Viram fontes da sessão com id opaco, em vez de uma lista de videoId
    // que o cliente concatenava na URL do provedor.
    let fontesPublicas: FontePublica[] | undefined;
    if (Array.isArray(result.fontes) && result.fontes.length) {
      const novas = result.fontes.map((f: CineVsFonte) => ({
        embedUrl: `${url}&video=${f.videoId}`,
        provider: fonte.provider,
        servidor: `${fonte.servidor} · ${f.label ?? f.audioType ?? f.videoId}`,
        idioma: fonte.idioma,
        tokenized: fonte.tokenized,
        nativo: fonte.nativo,
        iframeDireto: fonte.iframeDireto,
        iframeDesafio: fonte.iframeDesafio,
        iframeInvalido: fonte.iframeInvalido,
        semExtrator: !f.disponivel,
        disponivel: f.disponivel !== false,
        ...(f.motivoIndisponivel ? { motivoIndisponivel: f.motivoIndisponivel } : {}),
        videoId: f.videoId,
      }));
      const crescida = await acrescentarFontes(sessao, userId, novas);
      if (crescida) fontesPublicas = crescida.map(projetarPublica);
    }

    // MP4: stream token is single-use (SET NX) — JW Player makes multiple range requests
    // when seeking, so the second request always fails with "token já consumido".
    // Use a HMAC-signed proxy URL instead; it's stateless and allows repeated range requests.
    if (result.tipo === "mp4") {
      // CDNs com token tempo-limitado (não IP-bound): entrega URL direta ao browser
      // vod01e001.fun (Voltz) bloqueia IPs de datacenter; webcinevs2 usa cnvs_token tempo-limitado
      if (url.includes("voltz.php") || url.includes("webcinevs2.com")) {
        return NextResponse.json(
          { tipo: "mp4_direct", stream: result.stream, subtitles: result.subtitles, fontes: fontesPublicas },
          { headers: NO_STORE },
        );
      }
      const sig = signSegmentUrl(result.stream, userId);
      const ref = result.referer ? `&ref=${encodeURIComponent(result.referer)}` : "";
      const proxyUrl = `/api/player/proxy?url=${encodeURIComponent(result.stream)}&sig=${sig}${ref}`;
      return NextResponse.json({ tipo: "mp4", streamToken: proxyUrl }, { headers: NO_STORE });
    }

    // HLS direto: só para o webcine, e só com CORS comprovado na extração.
    // Uma variante HLS de anime custa ~188 MB de Transfer Out pelo proxy; indo
    // direto custa zero. Qualquer dúvida sobre o CORS cai no proxy (fechado).
    if (result.tipo === "hls" && result.corsLiberado && url.includes("webcinevs2.com")) {
      return NextResponse.json(
        { tipo: "hls_direct", stream: result.stream, subtitles: result.subtitles, fontes: fontesPublicas },
        { headers: NO_STORE },
      );
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

    return NextResponse.json(
      { tipo: result.tipo, streamToken, subtitles: result.subtitles, fontes: fontesPublicas },
      { headers: NO_STORE },
    );

  } catch (err: any) {
    const detalhe = String(err?.message).slice(0, 80);
    audit("stream_rejected", { userId, ip, ua, detail: `extração falhou: ${detalhe}` });
    xlog("iframe_fallback", { motivo: "erro", detalhe, provider: fonte.provider, fonte: fonte.ordem });
    if (fonte.iframeInvalido) {
      return NextResponse.json({ error: "Stream não encontrado", motivo: "erro" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ tipo: "iframe", stream: url, motivo: "erro" }, { headers: NO_STORE });
  }
}
