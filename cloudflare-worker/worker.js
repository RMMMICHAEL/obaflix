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
        JSON.stringify({ error: "worker exception", detail: String(err) }),
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
    embedUrl = decodeURIComponent(embedParam);
    new URL(embedUrl);
  } catch {
    return new Response("Invalid embedUrl", { status: 400 });
  }

  console.log(`[STREAM] embedUrl=${embedUrl}`);

  const securedLink = await extractEmbedPlayer(embedUrl);
  if (!securedLink) {
    console.error(`[STREAM] extraction failed for ${embedUrl}`);
    return new Response(
      JSON.stringify({ error: "extraction failed", embedUrl }),
      { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
    );
  }

  console.log(`[STREAM] securedLink=${securedLink}`);

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
      const body = await res.text();
      return new Response(`CDN ${res.status}: ${body}`, { status: res.status });
    }
    m3u8Text = await res.text();
    console.log(`[STREAM] master preview=\n${m3u8Text.slice(0, 300)}`);
  } catch (err) {
    console.error(`[STREAM] fetch master threw`, String(err));
    return new Response(String(err), { status: 502 });
  }

  const rewritten = rewriteM3u8(m3u8Text, securedLink, workerUrl.origin, embedUrl);

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
    targetUrl = decodeURIComponent(targetParam);
    new URL(targetUrl);
  } catch (err) {
    console.error(`[PROXY] invalid u: ${targetParam.slice(0, 100)}`, String(err));
    return new Response("Invalid u param", { status: 400 });
  }

  const referer = refererParam
    ? decodeURIComponent(refererParam)
    : new URL(targetUrl).origin + "/";

  console.log(`[PROXY] url=${targetUrl}`);
  console.log(`[PROXY] referer=${referer}`);

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
    return new Response(String(err), { status: 502 });
  }

  const contentType = res.headers.get("content-type") ?? "";
  console.log(`[PROXY] cdn status=${res.status} ct=${contentType} cl=${res.headers.get("content-length")}`);

  if (!res.ok && res.status !== 206) {
    const body = await res.text();
    console.error(`[PROXY] cdn error ${res.status} url=${targetUrl} body=${body.slice(0, 200)}`);
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
    console.log(`[PROXY] detected M3U8 finalUrl=${finalUrl}`);
    console.log(`[PROXY] playlist preview=\n${bodyText.slice(0, 400)}`);
    const rewritten = rewriteM3u8(bodyText, finalUrl, workerUrl.origin, referer);
    console.log(`[PROXY] rewritten preview=\n${rewritten.slice(0, 400)}`);
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
  console.log(`[EXTRACT] POST ${apiUrl}`);

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
    console.log(`[EXTRACT] status=${res.status} body=${text.slice(0, 200)}`);
    if (!text.trimStart().startsWith("{")) return null;
    const data = JSON.parse(text);
    return data.securedLink || data.videoSource || data.src || null;
  } catch (err) {
    console.error(`[EXTRACT] threw`, String(err));
    return null;
  }
}

// ── Reescrita de M3U8 ─────────────────────────────────────────────────────────

function rewriteM3u8(text, baseUrl, workerOrigin, playerReferer) {
  const parsedBase = new URL(baseUrl);
  const base = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
  const origin = parsedBase.origin;
  const proxyBase = `${workerOrigin}/proxy`;
  const refParam = playerReferer ? "&ref=" + encodeURIComponent(playerReferer) : "";

  function toAbsolute(href) {
    const h = href.trim();
    if (h.startsWith("http://") || h.startsWith("https://")) return h;
    if (h.startsWith("//")) return parsedBase.protocol + h;
    if (h.startsWith("/")) return origin + h;
    return base + h;
  }

  function wrapProxy(href) {
    return `${proxyBase}?u=${encodeURIComponent(toAbsolute(href))}${refParam}`;
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
      out.push(trimmed.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${wrapProxy(uri)}"`));
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
        console.log(`[REWRITE] filtered ad EXTINF+seg: ${toAbsolute(lines[segIdx].trim()).slice(0, 80)}`);
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
      console.log(`[REWRITE] filtered orphan ad: ${toAbsolute(trimmed).slice(0, 80)}`);
      continue;
    }

    out.push(wrapProxy(trimmed));
  }

  return out.join("\n");
}

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://obaflix.vercel.app",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Worker-Secret",
  };
}
