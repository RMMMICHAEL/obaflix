export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

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
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

// Envia script ofuscado para moon.php (exatamente como o app Megaflix faz)
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
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`moon.php HTTP ${res.status}`);
  return res.text();
}

// POST para API interna do player (rola / rola3 style)
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
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  return json.videoSource || json.src || "";
}

// ── Extratores por plataforma ─────────────────────────────────────────────────

async function extractLulu(html: string): Promise<string | null> {
  // Pega o eval(function(p,a,c,k,e,d)) → manda para moon.php → split em [{file:"
  const evalScript = extractEvalScript(html);
  if (!evalScript) return null;
  const decoded = await moon(evalScript);
  const src = decoded.split('[{file:"')[1]?.split('"')[0];
  return src?.startsWith("http") ? src : null;
}

async function extractHide(html: string, embedUrl: string): Promise<string | null> {
  // Pega o eval(function(p,a,c,k,e,d)) → moon.php → links.hls3 || hls2
  const evalScript = extractEvalScript(html);
  if (!evalScript) return null;
  const decoded = await moon(evalScript);
  // Tenta pegar links.hls3 ou hls2
  const linksMatch = decoded.match(/var\s+links\s*=\s*(\{[^;]+\})/);
  if (linksMatch) {
    try {
      const links = JSON.parse(linksMatch[1]);
      const src = links.hls3 || links.hls2 || links.hls4 || null;
      if (src) return src.startsWith("http") ? src : new URL(embedUrl).origin + src;
    } catch { /**/ }
  }
  // fallback: procura m3u8 direto
  return findM3u8(decoded);
}

async function extractWish(html: string, embedUrl: string): Promise<string | null> {
  // Mesmo padrão do hide
  return extractHide(html, embedUrl);
}

async function extractRola(id: string): Promise<string | null> {
  // POST para llanfairpwllgwyngy.com (rola) ou embedplayer1.xyz (rola3)
  try {
    const src = await postPlayer("https://llanfairpwllgwyngy.com/player/index.php", id);
    return src || null;
  } catch { return null; }
}

async function extractRola3(id: string): Promise<string | null> {
  try {
    const src = await postPlayer("https://embedplayer1.xyz/player/index.php", id);
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
  // Pega o primeiro bloco eval(function(p,a,c,k,e,d){...}) da página
  const idx = html.indexOf("eval(function(p,a,c,k,e,d)");
  if (idx === -1) return null;
  // Encontra o fechamento — procura pelo padrão final .split('|'),0,{}))
  const chunk = html.slice(idx, idx + 50000);
  const endIdx = chunk.search(/\.split\('\|'\)\s*,\s*0\s*,\s*\{\s*\}\s*\)\s*\)/);
  if (endIdx === -1) return chunk; // retorna o que tiver
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

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url obrigatória" }, { status: 400 });

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const pathname = parsed.pathname;
    const id = pathname.split("/").filter(Boolean).pop() ?? "";

    let streamUrl: string | null = null;

    // ── Rota por plataforma (exatamente como o app Megaflix) ──────────────────

    if (hostname.includes("lulu") || hostname.includes("luluvdo")) {
      const html = await fetchHtml(url, "https://megaflix.lat/");
      streamUrl = await extractLulu(html);

    } else if (hostname.includes("hide") || hostname.includes("playhide")) {
      const html = await fetchHtml(`https://playhide.shop/v/${id}`, "https://megaflix.lat/");
      streamUrl = await extractHide(html, url);

    } else if (hostname.includes("wish") || hostname.includes("hlswish") || hostname.includes("streamwish") || hostname.includes("playerwish")) {
      const html = await fetchHtml(url, "https://megaflix.lat/");
      streamUrl = await extractWish(html, url);

    } else if (hostname.includes("rola3") || hostname.includes("embedplayer1")) {
      streamUrl = await extractRola3(id);

    } else if (hostname.includes("rola") || hostname.includes("llanfair")) {
      streamUrl = await extractRola(id);

    } else if (hostname.includes("bolt")) {
      const html = await fetchHtml(url, "https://megaflix.lat/");
      streamUrl = await extractBolt(html);

    } else if (hostname.includes("big") || hostname.includes("bigshare")) {
      const html = await fetchHtml(url, "https://megaflix.lat/");
      streamUrl = await extractBig(html);

    } else {
      // Fallback genérico: busca m3u8 no HTML bruto
      const html = await fetchHtml(url, "https://megaflix.lat/");

      // Tenta moon.php se tiver eval script
      const evalScript = extractEvalScript(html);
      if (evalScript) {
        try {
          const decoded = await moon(evalScript);
          streamUrl = findM3u8(decoded) || decoded.split('[{file:"')[1]?.split('"')[0] || null;
        } catch { /**/ }
      }

      // Fallback: procura m3u8 direto no HTML
      if (!streamUrl) streamUrl = findM3u8(html);
    }

    if (!streamUrl) {
      return NextResponse.json({ error: "stream não encontrado" }, { status: 404 });
    }

    const tipo = streamUrl.includes(".mp4") ? "mp4" : "hls";
    return NextResponse.json({ stream: streamUrl, tipo });

  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "erro interno" }, { status: 500 });
  }
}
