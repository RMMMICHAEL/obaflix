/**
 * Obaflix Embed Proxy — Cloudflare Worker
 *
 * GET /stream?embedUrl=ENCODED_URL
 *   Extrai + busca M3U8 em um único request (mesmo PoP, mesmo IP de saída).
 *
 * GET /proxy?u=ENCODED_URL
 *   Proxia qualquer URL (M3U8, .ts, chaves AES) pelo IP deste Worker.
 *   Detecta M3U8 por CONTEÚDO (#EXTM3U) — não só pela extensão ou content-type —
 *   para lidar com CDNs que servem playlists em paths como /hls/BASE64.
 *   Todas as respostas usam Cache-Control: no-store para evitar cache de versões erradas.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if ((url.pathname === "/stream" || url.pathname === "/proxy") &&
        (!env.WORKER_SECRET || env.WORKER_SECRET.length < 32)) {
      return new Response("Worker not configured", { status: 503 });
    }

    if (url.pathname === "/stream" || url.pathname === "/proxy") {
      if (!(await verifySignedRequest(url, env.WORKER_SECRET))) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders(env) });
      }
    }

    try {
      if (request.method === "GET" && url.pathname === "/stream") {
        return await handleStream(request, url, env);
      }
      if (request.method === "GET" && url.pathname === "/proxy") {
        return await handleProxy(request, url, env);
      }
    } catch (err) {
      console.error(`[WORKER UNHANDLED] ${url.pathname}`, String(err), err?.stack);
      return new Response(
        JSON.stringify({ error: "worker exception" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ── /stream — extrai + serve M3U8 reescrito em um único request ───────────────

async function handleStream(request, workerUrl, env) {
  const embedParam = workerUrl.searchParams.get("embedUrl");
  if (!embedParam) return new Response("Missing embedUrl", { status: 400 });

  let embedUrl;
  try {
    embedUrl = embedParam;
    if (!isAllowedEmbedUrl(embedUrl)) throw new Error("provider not allowed");
  } catch {
    return new Response("Invalid embedUrl", { status: 400 });
  }

  const securedLink = await extractEmbedPlayer(embedUrl);
  if (!securedLink) {
    console.error("[STREAM] extraction failed");
    return new Response(
      JSON.stringify({ error: "extraction failed" }),
      { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
    );
  }

  if (!isPublicHttpsUrl(securedLink)) {
    return new Response("Invalid upstream media URL", { status: 502 });
  }

  let m3u8Text;
  try {
    const res = await fetch(securedLink, {
      headers: {
        "User-Agent": UA,
        "Referer": new URL(embedUrl).origin + "/",
        "Origin": new URL(embedUrl).origin,
      },
    });
    console.log(`[STREAM] master status=${res.status} ct=${res.headers.get("content-type")}`);
    if (!res.ok) {
      res.body?.cancel();
      return new Response("Upstream media error", { status: res.status });
    }
    m3u8Text = await res.text();
  } catch (err) {
    console.error(`[STREAM] fetch master threw`, String(err));
    return new Response("Upstream media error", { status: 502 });
  }

  const rewritten = await rewriteM3u8(m3u8Text, securedLink, workerUrl.origin, embedUrl, env);

  return new Response(rewritten, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
      ...corsHeaders(env),
    },
  });
}

// ── /proxy — proxia qualquer URL detectando M3U8 por conteúdo ────────────────

async function handleProxy(request, workerUrl, env) {
  const targetParam = workerUrl.searchParams.get("u");
  if (!targetParam) return new Response("Missing u param", { status: 400 });

  const refererParam = workerUrl.searchParams.get("ref");

  let targetUrl;
  try {
    targetUrl = targetParam;
    if (!isPublicHttpsUrl(targetUrl)) throw new Error("target not allowed");
  } catch (err) {
    console.error("[PROXY] invalid target", String(err));
    return new Response("Invalid u param", { status: 400 });
  }

  const referer = refererParam
    ? refererParam
    : new URL(targetUrl).origin + "/";

  let res;
  try {
    res = await fetch(targetUrl, {
      headers: {
        "User-Agent": UA,
        "Referer": referer,
        "Origin": new URL(targetUrl).origin,
      },
    });
  } catch (err) {
    console.error(`[PROXY] fetch threw`, String(err));
    return new Response("Upstream media error", { status: 502 });
  }

  const contentType = res.headers.get("content-type") ?? "";
  console.log(`[PROXY] cdn status=${res.status} ct=${contentType} cl=${res.headers.get("content-length")}`);

  if (!res.ok && res.status !== 206) {
    res.body?.cancel();
    console.error(`[PROXY] cdn error ${res.status}`);
    // Ad/tracking servers (dahds*.xyz etc) injetados no M3U8 retornam 5xx.
    // Retorna 204 (vazio) para que o HLS.js pule o "segmento" sem abortar.
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store", ...corsHeaders(env) },
    });
  }

  // ── Detecção de M3U8 por conteúdo ────────────────────────────────────────
  // Nunca confia só no content-type: CDNs como embedplayer2 retornam
  // "video/mp2t" para playlists M3U8, forçando detecção por conteúdo.
  // Segmentos .ts reais não começam com "#EXT", então isso é discriminador seguro.

  let bodyText;
  try {
    bodyText = await res.clone().text();
  } catch {
    console.error(`[PROXY] clone failed, streaming as binary`);
    return streamBinary(res, env);
  }

  const isClearlyM3u8 =
    contentType.includes("mpegurl") ||
    contentType.includes("x-mpegurl") ||
    targetUrl.split("?")[0].endsWith(".m3u8");

  const isM3u8 = isClearlyM3u8 || bodyText.trimStart().startsWith("#EXT");

  if (isM3u8) {
    const finalUrl = res.url || targetUrl;
    console.log("[PROXY] detected M3U8");
    const rewritten = await rewriteM3u8(bodyText, finalUrl, workerUrl.origin, referer, env);
    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        ...corsHeaders(env),
      },
    });
  }

  console.log(`[PROXY] binary segment cl=${res.headers.get("content-length")}`);
  return streamBinary(res, env);
}

function streamBinary(res, env) {
  const ct = res.headers.get("content-type") ?? "video/mp2t";
  const headers = new Headers({
    "Content-Type": ct,
    "Cache-Control": "no-store",   // evita cache de conteúdo IP-bound
    ...corsHeaders(env),
  });
  const cl = res.headers.get("content-length");
  if (cl) headers.set("Content-Length", cl);
  const cr = res.headers.get("content-range");
  if (cr) headers.set("Content-Range", cr);
  return new Response(res.body, { status: res.status, headers });
}

// ── Extração de securedLink ───────────────────────────────────────────────────

async function extractEmbedPlayer(embedUrl) {
  const parsed = new URL(embedUrl);
  const base = `${parsed.protocol}//${parsed.hostname}`;
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!id) return null;

  const form = new URLSearchParams();
  form.append("hash", id);
  form.append("r", "https://megaflix.lat/");

  const apiUrl = `${base}/player/index.php?data=${id}&do=getVideo`;
  try {
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
    });
    const text = await res.text();
    console.log(`[EXTRACT] status=${res.status}`);
    if (!text.trimStart().startsWith("{")) return null;
    const data = JSON.parse(text);
    return data.securedLink || data.videoSource || data.src || null;
  } catch (err) {
    console.error(`[EXTRACT] threw`, String(err));
    return null;
  }
}

// ── Reescrita de M3U8 ─────────────────────────────────────────────────────────

async function rewriteM3u8(text, baseUrl, workerOrigin, playerReferer, env) {
  const parsedBase = new URL(baseUrl);
  const base = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
  const origin = parsedBase.origin;
  const proxyBase = `${workerOrigin}/proxy`;

  function toAbsolute(href) {
    const h = href.trim();
    if (h.startsWith("http://") || h.startsWith("https://")) return h;
    if (h.startsWith("//")) return parsedBase.protocol + h;
    if (h.startsWith("/")) return origin + h;
    return base + h;
  }

  async function wrapProxy(href) {
    const params = new URLSearchParams({ u: toAbsolute(href) });
    if (playerReferer) params.set("ref", playerReferer);
    return createSignedUrl(proxyBase, "/proxy", params, env.WORKER_SECRET);
  }

  async function rewriteUriAttributes(line) {
    const matches = [...line.matchAll(/URI="([^"]+)"/g)];
    let rewritten = line;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const signed = await wrapProxy(match[1]);
      rewritten = rewritten.slice(0, match.index) + `URI="${signed}"` +
        rewritten.slice(match.index + match[0].length);
    }
    return rewritten;
  }

  // Extensões usadas por ad-trackers injetados no M3U8 (nunca usadas em segmentos de vídeo)
  const AD_EXT_RE = /\.(js|html|css|php|gif|png|jpg|jpeg|svg|woff|woff2|ttf|otf|eot)(\?|$)/i;

  function isAdUrl(href) {
    try {
      const abs = toAbsolute(href);
      return abs.startsWith("http") && AD_EXT_RE.test(abs);
    } catch {
      return false;
    }
  }

  const lines = text.split("\n");
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") { out.push(line); continue; }

    // Tags com atributo URI
    if (/^#EXT-X-(KEY|MAP|MEDIA|SESSION-KEY)/.test(trimmed)) {
      out.push(await rewriteUriAttributes(trimmed));
      continue;
    }

    // #EXTINF — lookahead: se próximo segmento for ad, descarta ambos sem deixar #EXTINF órfão
    if (/^#EXTINF/.test(trimmed)) {
      let segIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith("#")) { segIdx = j; break; }
      }
      if (segIdx !== -1 && isAdUrl(lines[segIdx].trim())) {
        i = segIdx; // avança o loop para além do segmento
        continue;
      }
      out.push(line);
      continue;
    }

    // Outros comentários
    if (trimmed.startsWith("#")) { out.push(line); continue; }

    // URL de segmento ou variante — filtra ad sem #EXTINF precedente (raro)
    if (isAdUrl(trimmed)) {
      continue;
    }

    out.push(await wrapProxy(trimmed));
  }

  return out.join("\n");
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function canonicalRequest(pathname, params, exp) {
  const canonical = new URLSearchParams(params);
  canonical.delete("sig");
  canonical.sort();
  return `${pathname}\n${exp}\n${canonical.toString()}`;
}

async function createSignedUrl(base, pathname, params, secret) {
  const target = new URL(base);
  const exp = String(Math.floor(Date.now() / 1000) + 10 * 60);
  params.set("exp", exp);
  params.sort();
  target.search = params.toString();
  target.searchParams.set("sig", await hmac(canonicalRequest(pathname, target.searchParams, exp), secret));
  return target.toString();
}

async function verifySignedRequest(url, secret) {
  const now = Math.floor(Date.now() / 1000);
  const exp = url.searchParams.get("exp") || "";
  const sig = url.searchParams.get("sig") || "";
  if (!/^\d{10}$/.test(exp) || Number(exp) < now || Number(exp) > now + 15 * 60 || !sig) return false;
  const expected = await hmac(canonicalRequest(url.pathname, url.searchParams, exp), secret);
  return constantTimeEqual(expected, sig);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}

const EMBED_HOSTS = [
  "playerflix.ink", "webcinevs2.com", "playhide.shop", "hidehide.shop",
  "vidhidehub.com", "streamwish.com", "playerwish.com", "hlswish.com",
  "wishonly.site", "cdnwish.com", "asnwish.com", "swishsrv.com",
  "luluvdo.com", "lulu.gg", "luluvid.com", "lulustream.com",
  "embedplayer1.xyz", "embedplayer2.xyz",
  "xn--kcksk7a2bl5le7b6doc1h3f.com", "llanfairpwllgwyngy.com",
  "boltcdn.xyz", "upbolt.to", "bigshare.link", "superflixapi.pro", "superflixapi.sbs",
  "v1.watchplay.shop", "megafrixapi.com", "vods.faz-o-eli.online",
];

function allowedHost(hostname, allowed) {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

function isAllowedEmbedUrl(raw) {
  if (!isPublicHttpsUrl(raw)) return false;
  const hostname = new URL(raw).hostname.toLowerCase();
  return EMBED_HOSTS.some((allowed) => allowedHost(hostname, allowed));
}

function isPublicHttpsUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
  if (/^(192\.0\.(0|2)|198\.(18|19|51\.100)|203\.0\.113)\./.test(host)) return false;
  if (host.includes(":") && (
    host === "::" || host === "::1" || host.startsWith("::ffff:") ||
    host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") ||
    host.startsWith("ff") || host.startsWith("2001:db8")
  )) return false;
  return true;
}

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://obaflix.vercel.app",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
