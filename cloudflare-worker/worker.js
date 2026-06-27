/**
 * Obaflix Embed Proxy — Cloudflare Worker
 *
 * GET /stream?embedUrl=ENCODED_URL
 *   Extrai + busca M3U8 em um único request (mesmo PoP, mesmo IP de saída).
 *   Reescreve todas as URLs para /proxy, incluindo EXT-X-KEY e EXT-X-MAP.
 *   Chamado diretamente pelo browser — sem auth (HLS.js não suporta headers custom).
 *
 * GET /proxy?u=ENCODED_URL
 *   Proxia qualquer URL (M3U8, .ts, chaves AES) pelo IP deste Worker.
 *   Reescreve M3U8 recursivamente. Chamado pelo HLS player para cada segmento.
 *
 * Arquitetura de IP:
 *   O browser chama /stream → Cloudflare roteia para o PoP mais próximo do usuário.
 *   Extração e M3U8 inicial saem desse mesmo PoP.
 *   Requests /proxy subsequentes do mesmo browser vão para o mesmo PoP (anycast).
 *   → IP de saída consistente durante toda a sessão.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method === "GET") {
      if (url.pathname === "/stream") return handleStream(request, url, env);
      if (url.pathname === "/proxy") return handleProxy(request, url, env);
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

  // Extrai o securedLink do player usando o IP deste PoP
  const securedLink = await extractEmbedPlayer(embedUrl);
  if (!securedLink) {
    return new Response(
      JSON.stringify({ error: "extraction failed", embedUrl }),
      { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
    );
  }

  // Busca o master.m3u8 com o mesmo IP que fez a extração
  let m3u8Text;
  try {
    const res = await fetch(securedLink, {
      headers: {
        "User-Agent": UA,
        "Referer": new URL(embedUrl).origin + "/",
        "Origin": new URL(embedUrl).origin,
      },
    });
    if (!res.ok) {
      return new Response(`CDN ${res.status} on master.m3u8`, { status: res.status });
    }
    m3u8Text = await res.text();
  } catch (err) {
    return new Response(String(err), { status: 502 });
  }

  const rewritten = rewriteM3u8(m3u8Text, securedLink, workerUrl.origin, embedUrl);

  return new Response(rewritten, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache",
      ...corsHeaders(env),
    },
  });
}

// ── /proxy — proxia qualquer URL (M3U8, segmentos, chaves AES) ───────────────

async function handleProxy(request, workerUrl, env) {
  const targetParam = workerUrl.searchParams.get("u");
  if (!targetParam) return new Response("Missing u param", { status: 400 });

  // Referer original do player pode ser passado para headers corretos
  const refererParam = workerUrl.searchParams.get("ref");

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(targetParam);
    new URL(targetUrl);
  } catch {
    return new Response("Invalid u param", { status: 400 });
  }

  let referer = refererParam ? decodeURIComponent(refererParam) : new URL(targetUrl).origin + "/";

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
    return new Response(String(err), { status: 502 });
  }

  if (!res.ok && res.status !== 206) {
    return new Response(await res.text(), { status: res.status });
  }

  const contentType = res.headers.get("content-type") ?? "";
  const isM3u8 =
    contentType.includes("mpegurl") ||
    contentType.includes("x-mpegurl") ||
    targetUrl.split("?")[0].endsWith(".m3u8");

  if (isM3u8) {
    const text = await res.text();
    const rewritten = rewriteM3u8(text, targetUrl, workerUrl.origin, referer);
    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
        ...corsHeaders(env),
      },
    });
  }

  // Binário: .ts, chaves AES, etc.
  const headers = new Headers({
    "Content-Type": contentType || "video/mp2t",
    "Cache-Control": "public, max-age=3600",
    ...corsHeaders(env),
  });
  const cl = res.headers.get("content-length");
  if (cl) headers.set("Content-Length", cl);
  const cr = res.headers.get("content-range");
  if (cr) headers.set("Content-Range", cr);

  return new Response(res.body, { status: res.status, headers });
}

// ── Extração de securedLink via POST (embedplayer2 / xnn) ────────────────────

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
    if (!text.trimStart().startsWith("{")) return null;
    const data = JSON.parse(text);
    return data.securedLink || data.videoSource || data.src || null;
  } catch {
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
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    if (href.startsWith("//")) return parsedBase.protocol + href;
    if (href.startsWith("/")) return origin + href;
    return base + href;
  }

  function wrapProxy(href) {
    return `${proxyBase}?u=${encodeURIComponent(toAbsolute(href))}${refParam}`;
  }

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      if (trimmed === "") return line;

      // Reescreve URI dentro de tags de metadados (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, etc.)
      if (trimmed.startsWith("#EXT-X-KEY") ||
          trimmed.startsWith("#EXT-X-MAP") ||
          trimmed.startsWith("#EXT-X-MEDIA") ||
          trimmed.startsWith("#EXT-X-SESSION-KEY")) {
        return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${wrapProxy(uri)}"`);
      }

      // Ignora outros comentários
      if (trimmed.startsWith("#")) return line;

      // Linha de URL (segmento ou playlist variante)
      return wrapProxy(trimmed);
    })
    .join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://obaflix.vercel.app",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Worker-Secret",
  };
}
