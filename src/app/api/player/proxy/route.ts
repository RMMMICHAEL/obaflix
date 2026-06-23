export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { HttpsProxyAgent } from "https-proxy-agent";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PROXY = process.env.RESIDENTIAL_PROXY;

function getAgent() {
  if (!PROXY) return undefined;
  return new HttpsProxyAgent(PROXY);
}

// Domínios e padrões de scripts de anúncio a remover
const AD_SCRIPT_PATTERNS = [
  /adsterra/i, /popads/i, /popcash/i, /juicyads/i, /exoclick/i,
  /trafficjunky/i, /moonadtag/i, /monetag/i, /hilltopads/i,
  /adspyglass/i, /propellerads/i, /adcash/i, /bidvertiser/i,
  /valueimpression/i, /richpush/i, /mgid/i, /revcontent/i,
  /taboola/i, /outbrain/i, /adnxs\.com/i, /doubleclick/i,
  /googlesyndication/i, /adservice\.google/i, /smartadserver/i,
  /adform/i, /openx/i, /rubiconproject/i, /pubmatic/i,
  /33across/i, /indexww/i, /sovrn/i, /triplelift/i,
  /adsrvr/i, /casalemedia/i, /contextweb/i, /liveintent/i,
  /spotxchange/i, /teads/i, /sharethrough/i, /yieldmo/i,
  /criteo/i, /amazon-adsystem/i, /adsafeprotected/i,
  /doubleverify/i, /ias\.global/i, /moatads/i, /confiant/i,
  /pop(?:under|up|wunder)/i,
];

const AD_INLINE_PATTERNS = [
  /window\.open\s*\(/g,
  /document\.location\s*=/g,
  /top\.location\s*=/g,
  /window\.location\.replace/g,
];

function stripAds(html: string, baseUrl: string): string {
  const base = new URL(baseUrl);

  html = html.replace(/<script[^>]+src\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/script>/gi, (tag, src) => {
    if (AD_SCRIPT_PATTERNS.some((re) => re.test(src))) return "<!-- ad removed -->";
    return tag;
  });

  html = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (tag, content) => {
    if (AD_SCRIPT_PATTERNS.some((re) => re.test(content))) return "<!-- ad removed -->";
    let cleaned = content;
    for (const re of AD_INLINE_PATTERNS) {
      cleaned = cleaned.replace(re, (m: string) => `/* blocked */ void(0); // ${m.slice(0, 30)}`);
    }
    return tag.replace(content, cleaned);
  });

  html = html.replace(/<iframe[^>]+src\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>/gi, (tag, src) => {
    if (AD_SCRIPT_PATTERNS.some((re) => re.test(src))) return "<!-- iframe ad removed -->";
    return tag;
  });

  html = html.replace(/(src|href|action)\s*=\s*["'](\/?[^"'http][^"']*?)["']/gi, (match, attr, path) => {
    if (path.startsWith("//")) return `${attr}="${base.protocol}${path}"`;
    if (path.startsWith("/")) return `${attr}="${base.origin}${path}"`;
    return match;
  });

  if (!html.includes("<base ")) {
    html = html.replace("<head>", `<head><base href="${base.origin}/">`);
  }

  const blocker = `
<script>
(function(){
  window.open = function(){ return null; };
})();
</script>`;
  html = html.replace("</head>", blocker + "</head>");

  return html;
}

function errorHtml(msg: string) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;color:#aaa;font-size:14px">${msg}</body></html>`;
}

function makeAbort(ms: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("url obrigatória", { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return new NextResponse(errorHtml("URL inválida"), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const { signal, clear } = makeAbort(20000);
  try {
    const agent = getAgent();
    const res = await fetch(url, {
      signal,
      // @ts-expect-error node-fetch accepts agent
      agent,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        Referer: parsed.origin + "/",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      return new NextResponse(errorHtml(`Fonte indisponível (${res.status})`), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const html = await res.text();
    const clean = stripAds(html, url);

    return new NextResponse(clean, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "SAMEORIGIN",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "erro";
    return new NextResponse(errorHtml(msg), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } finally {
    clear();
  }
}
