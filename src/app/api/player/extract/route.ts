export const dynamic = "force-dynamic";
export const maxDuration = 60;
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl } from "@/lib/ssrf";
import {
  verifyPlayToken,
  createStreamToken,
  isIpBlocked,
  recordAbuseAttempt,
} from "@/lib/playTokens";

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

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchHtml(url: string, referer = ""): Promise<string> {
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
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

async function moon(obfuscatedScript: string): Promise<string> {
  const encoded = Buffer.from(obfuscatedScript).toString("base64");
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
  if (!res.ok) throw new Error(`moon.php HTTP ${res.status}`);
  return res.text();
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

async function extractHide(html: string, embedUrl: string): Promise<string | null> {
  const evalScript = extractEvalScript(html);
  if (!evalScript) return null;
  const decoded = await moon(evalScript);
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

async function extractWish(html: string, embedUrl: string): Promise<string | null> {
  const parsed = new URL(embedUrl);
  const id = parsed.pathname.split("/").filter(Boolean).pop() ?? "";

  if (id) {
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
          if (src?.startsWith("http")) return src;
        }
      }
    } catch { /* tenta próximo método */ }
  }

  const direct = findM3u8(html);
  if (direct) return direct;

  const fileSplit = html.split('[{file:"')[1]?.split('"')[0];
  if (fileSplit?.startsWith("http")) return fileSplit;

  const jwMatch = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i);
  if (jwMatch?.[1]?.startsWith("http")) return jwMatch[1];

  const jsonFile = html.match(/"file"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i);
  if (jsonFile?.[1]) return jsonFile[1];

  return extractHide(html, embedUrl);
}

async function extractRola(id: string): Promise<string | null> {
  try {
    const src = await postPlayer("https://llanfairpwllgwyngy.com/player/index.php", id);
    return src || null;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractEvalScript(html: string): string | null {
  const idx = html.indexOf("eval(function(p,a,c,k,e,d)");
  if (idx === -1) return null;
  const chunk = html.slice(idx, idx + 50000);
  const endIdx = chunk.search(/\.split\('\|'\)\s*,\s*0\s*,\s*\{\s*\}\s*\)\s*\)/);
  if (endIdx === -1) return chunk;
  return chunk.slice(0, endIdx + 30);
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

async function doExtract(url: string): Promise<{ stream: string; tipo: string; referer?: string }> {
  const parsed = await assertSafeUrl(url);
  const hostname = parsed.hostname;
  const pathname = parsed.pathname;
  const id = pathname.split("/").filter(Boolean).pop() ?? "";

  let streamUrl: string | null = null;
  let referer: string | undefined;

  if (pathname.includes("vast.php")) {
    const linkParam = parsed.searchParams.get("link");
    if (!linkParam) return { stream: url, tipo: "iframe" };
    const innerUrl = Buffer.from(linkParam, "base64").toString("utf-8");
    return doExtract(innerUrl);
  }

  if (hostname.includes("voltz.php") || pathname.includes("voltz.php")) {
    streamUrl = await extractVoltz(url);

  } else if (hostname.includes("lulu") || hostname.includes("luluvdo")) {
    return { stream: url, tipo: "iframe" };

  } else if (hostname.includes("hide") || hostname.includes("playhide")) {
    const html = await fetchHtml(`https://playhide.shop/v/${id}`, "https://megaflix.lat/");
    streamUrl = await extractHide(html, url);

  } else if (hostname.includes("wish") || hostname.includes("hlswish") || hostname.includes("streamwish") || hostname.includes("playerwish")) {
    const html = await fetchHtml(url, "https://megaflix.lat/");
    streamUrl = await extractWish(html, url);

  } else if (
    pathname.includes("/rola4/") ||
    pathname.includes("/rola3/") ||
    hostname.includes("embedplayer") ||
    hostname.includes("rola3")
  ) {
    // Retorna URL do Worker — será armazenada no stream token e nunca exposta ao browser
    const workerUrl = process.env.EMBED_WORKER_URL;
    if (!workerUrl) return { stream: url, tipo: "iframe" };
    streamUrl = `${workerUrl}/stream?embedUrl=${encodeURIComponent(url)}`;

  } else if (hostname.includes("rola") || hostname.includes("llanfair")) {
    streamUrl = await extractRola(id);

  } else if (hostname.includes("bolt")) {
    const html = await fetchHtml(url, "https://megaflix.lat/");
    streamUrl = await extractBolt(html);

  } else if (hostname.includes("big") || hostname.includes("bigshare")) {
    const html = await fetchHtml(url, "https://megaflix.lat/");
    streamUrl = await extractBig(html);

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
  return { stream: streamUrl, tipo, referer };
}

export async function GET(req: NextRequest) {
  const ip = clientIp(req);
  const ua = clientUa(req);

  if (isIpBlocked(ip)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 429 });
  }

  // Origin deve ser nosso próprio domínio
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !origin.includes(host)) {
    recordAbuseAttempt(ip);
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    recordAbuseAttempt(ip);
    return NextResponse.json({ error: "Acesso negado" }, { status: 401 });
  }

  const userId = (session.user as { id: string }).id;
  if (!userId) return NextResponse.json({ error: "Acesso negado" }, { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  const playToken = req.nextUrl.searchParams.get("playToken");

  if (!url || !playToken) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 400 });
  }

  const tokenCheck = verifyPlayToken(playToken, userId, url, ip);
  if (!tokenCheck.ok) {
    recordAbuseAttempt(ip);
    // Log interno (nunca exposto ao cliente)
    console.warn("[player/extract] play token inválido", { userId, ip, ua: ua.slice(0, 80) });
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  if (tokenCheck.ipMismatch) {
    console.info("[player/extract] IP mismatch no play token (rede móvel?)", { userId, ip });
  }

  try {
    const result = await Promise.race([
      doExtract(url),
      new Promise<{ stream: string; tipo: string; referer?: string }>((resolve) =>
        setTimeout(() => resolve({ stream: url, tipo: "iframe" }), EXTRACT_TIMEOUT_MS)
      ),
    ]);

    if (result.tipo === "iframe") {
      return NextResponse.json({ tipo: "iframe", stream: result.stream });
    }

    const { token: streamToken, accepted } = createStreamToken(
      userId,
      result.stream,
      result.referer ?? null,
      ip,
      ua,
    );

    if (!accepted) {
      console.warn("[player/extract] limite de streams simultâneos atingido", { userId });
      return NextResponse.json({ error: "Limite de reproduções simultâneas atingido" }, { status: 429 });
    }

    return NextResponse.json({ tipo: result.tipo, streamToken });

  } catch (err: any) {
    // Detalhe do erro apenas no log; cliente recebe mensagem genérica
    console.error("[player/extract] erro na extração", { url: url.slice(0, 100), err: err?.message });
    return NextResponse.json({ tipo: "iframe", stream: url });
  }
}
