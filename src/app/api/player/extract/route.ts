export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function makeAbort(ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

async function get(url: string, referer: string): Promise<string> {
  const { signal, clear } = makeAbort(12000);
  try {
    const res = await fetch(url, {
      signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        Referer: referer,
        Origin: new URL(url).origin,
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clear();
  }
}

async function post(url: string, body: string, referer: string, contentType = "application/x-www-form-urlencoded"): Promise<string> {
  const { signal, clear } = makeAbort(12000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "User-Agent": UA,
        Accept: "application/json, */*",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "Content-Type": contentType,
        Referer: referer,
        Origin: new URL(url).origin,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clear();
  }
}

// ─── per-platform API extraction ───────────────────────────────────────────

async function tryPlayerApi(embedUrl: string): Promise<string | null> {
  const u = new URL(embedUrl);
  const id = u.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!id) return null;

  // Common API endpoints used by these platforms
  const candidates = [
    // playerwish / streamwish / filemoon style
    { url: `${u.origin}/api/source/${id}`, body: `r=&d=${u.hostname}` },
    // doodstream style
    { url: `${u.origin}/pass_md5/${id}`, body: "" },
    // luluvdo / upstream style
    { url: `${u.origin}/api/v/${id}`, body: `r=${encodeURIComponent(embedUrl)}&d=${u.hostname}` },
  ];

  for (const c of candidates) {
    try {
      const raw = await post(c.url, c.body, embedUrl);
      const json = JSON.parse(raw);

      // { data:[{file:"..."}] } or { file:"..." } or { url:"..." }
      const src: string =
        json?.data?.[0]?.file ??
        json?.data?.[0]?.url ??
        json?.data?.file ??
        json?.file ??
        json?.url ??
        json?.src ??
        "";

      if (src && src.startsWith("http")) return src;
    } catch {
      // try next
    }
  }
  return null;
}

// ─── regex extraction from raw HTML ────────────────────────────────────────

function unpackEval(chunk: string): string {
  const m = chunk.match(
    /eval\s*\(\s*function\s*\(p,a,c,k,e,[dr]\)\s*\{[\s\S]+?\}\s*\(\s*'([\s\S]+?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]+?)'\.split/
  );
  if (!m) return chunk;
  try {
    const [, p, , , k] = m;
    const a = parseInt(m[2]);
    const c = parseInt(m[3]);
    const keys = k.split("|");
    let out = p;
    for (let i = c - 1; i >= 0; i--) {
      out = out.replace(new RegExp(`\\b${i.toString(a)}\\b`, "g"), keys[i] || i.toString(a));
    }
    return out;
  } catch {
    return chunk;
  }
}

function decodeBase64Blobs(text: string): string {
  return text.replace(/["']([A-Za-z0-9+/]{40,}={0,2})["']/g, (orig, b64) => {
    try {
      const dec = Buffer.from(b64, "base64").toString("utf8");
      if (dec.includes("m3u8") || dec.includes(".mp4") || dec.includes("http")) return `"${dec}"`;
    } catch { /**/ }
    return orig;
  });
}

const STREAM_RE: RegExp[] = [
  /sources\s*:\s*\[\s*\{[^}]*["']?file["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/i,
  /["']?file["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/i,
  /["']?source["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/i,
  /["']?src["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/i,
  /(https?:\/\/[^"'\s\\,<>]+\.m3u8[^"'\s\\,<>]*)/i,
  /["']?file["']?\s*:\s*["']([^"']+\.mp4[^"']*)/i,
  /(https?:\/\/[^"'\s\\,<>]+\.mp4[^"'\s\\,<>]*)/i,
];

function findStream(text: string): string | null {
  for (const re of STREAM_RE) {
    const m = text.match(re);
    if (m?.[1]?.startsWith("http")) return m[1].trim();
  }
  return null;
}

function extractFromHtml(html: string): string | null {
  // raw
  let found = findStream(html);
  if (found) return found;

  // scripts only
  const scripts: string[] = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) {
    if (sm[1].trim()) scripts.push(sm[1]);
  }
  const scriptText = scripts.join("\n");

  found = findStream(scriptText);
  if (found) return found;

  // unpack eval blocks
  for (const match of scriptText.matchAll(/eval\(function\(p,a,c,k,e/gi)) {
    const start = match.index ?? 0;
    const chunk = scriptText.slice(start, start + 10000);
    const unpacked = unpackEval(chunk);
    found = findStream(unpacked);
    if (found) return found;
  }

  // base64
  found = findStream(decodeBase64Blobs(scriptText));
  if (found) return found;

  return null;
}

// ─── main handler ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url obrigatória" }, { status: 400 });

  let streamUrl: string | null = null;

  // 1. Try platform-specific POST API (fastest, most reliable)
  try {
    streamUrl = await tryPlayerApi(url);
  } catch { /**/ }

  // 2. Try fetching the embed HTML and scanning it
  if (!streamUrl) {
    try {
      const html = await get(url, new URL(url).origin + "/");
      streamUrl = extractFromHtml(html);

      // 3. Check for nested embed URL and recurse once
      if (!streamUrl) {
        const nested = html.match(
          /["'](https?:\/\/(?:playerwish|luluvdo|playhide|hlswish|listeamed|streamwish|filemoon|voe\.sx|dood)[^"']{8,})["']/i
        );
        if (nested) {
          try {
            streamUrl = await tryPlayerApi(nested[1]);
            if (!streamUrl) {
              const html2 = await get(nested[1], url);
              streamUrl = extractFromHtml(html2);
            }
          } catch { /**/ }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "erro";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  if (!streamUrl) {
    return NextResponse.json({ error: "stream não encontrado" }, { status: 404 });
  }

  const tipo = streamUrl.includes(".mp4") ? "mp4" : "hls";
  return NextResponse.json({ stream: streamUrl, tipo });
}
