/**
 * Obaflix Embed Proxy — Cloudflare Worker
 *
 * Dois endpoints:
 *
 * POST / { "url": "https://embedplayer2.xyz/rola3/HASH" }
 *   → Extrai o securedLink e devolve já embrulhado no proxy:
 *     { "securedLink": "https://obaflix-proxy.obavercel.workers.dev/proxy?u=..." }
 *
 * GET /proxy?u=ENCODED_URL
 *   → Proxia qualquer URL pelo IP deste Worker.
 *     Se for M3U8 reescreve todas as URLs de segmentos para também passarem por aqui.
 *     Isso garante que extração + segmentos saiam do mesmo IP → sem 403 IP-bound.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method === "GET" && url.pathname === "/proxy") {
      return handleProxy(request, url, env);
    }

    if (request.method === "POST" && url.pathname === "/") {
      return handleExtract(request, url, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ── Extração ──────────────────────────────────────────────────────────────────

async function handleExtract(request, workerUrl, env) {
  const secret = request.headers.get("X-Worker-Secret");
  if (env.WORKER_SECRET && secret !== env.WORKER_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { url } = body;
  if (!url || typeof url !== "string") {
    return json({ error: "url required" }, 400, env);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return json({ error: "invalid url" }, 400, env);
  }

  const base = `${parsed.protocol}//${parsed.hostname}`;
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";

  if (!id) {
    return json({ error: "hash not found in path" }, 400, env);
  }

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
        "Referer": url,
        "Origin": base,
      },
      body: form.toString(),
    });

    const text = await res.text();

    if (!text.trimStart().startsWith("{")) {
      return json({ error: "player returned non-JSON", raw: text.slice(0, 200) }, 502, env);
    }

    const data = JSON.parse(text);
    const securedLink = data.securedLink || data.videoSource || data.src || "";

    if (!securedLink) {
      return json({ error: "no stream in response", raw: data }, 502, env);
    }

    // Embrulha o link no proxy para que extração e segmentos saiam do mesmo IP
    const proxied = `${workerUrl.origin}/proxy?u=${encodeURIComponent(securedLink)}`;
    return json({ securedLink: proxied, videoSource: proxied }, 200, env);
  } catch (err) {
    return json({ error: String(err) }, 502, env);
  }
}

// ── Proxy de M3U8 e segmentos ─────────────────────────────────────────────────

async function handleProxy(request, workerUrl, env) {
  const targetParam = workerUrl.searchParams.get("u");
  if (!targetParam) return new Response("Missing u param", { status: 400 });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(targetParam);
    new URL(targetUrl); // valida
  } catch {
    return new Response("Invalid u param", { status: 400 });
  }

  let res;
  try {
    res = await fetch(targetUrl, {
      headers: {
        "User-Agent": UA,
        "Referer": new URL(targetUrl).origin + "/",
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
    targetUrl.includes(".m3u8");

  if (isM3u8) {
    const text = await res.text();
    const rewritten = rewriteM3u8(text, targetUrl, workerUrl.origin);
    return new Response(rewritten, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
        ...corsHeaders(env),
      },
    });
  }

  // Passa binário (segmentos .ts, .aac, etc.) diretamente
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function rewriteM3u8(text, baseUrl, workerOrigin) {
  const base = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
  const origin = new URL(baseUrl).origin;
  const proxyBase = `${workerOrigin}/proxy?u=`;

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return line;

      let absolute;
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        absolute = trimmed;
      } else if (trimmed.startsWith("/")) {
        absolute = origin + trimmed;
      } else {
        absolute = base + trimmed;
      }

      return proxyBase + encodeURIComponent(absolute);
    })
    .join("\n");
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://obaflix.vercel.app",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Worker-Secret",
  };
}
