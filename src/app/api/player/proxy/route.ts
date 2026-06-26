export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl } from "@/lib/ssrf";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function rewriteAttrUri(line: string, attr: string, base: string, parsedOrigin: string, proxyOrigin: string, ref: string): string {
  const re = new RegExp(`(${attr}=")([^"]+)(")`);
  return line.replace(re, (_, pre, uri: string, post) => {
    const absUri = uri.startsWith("http") ? uri : uri.startsWith("/") ? parsedOrigin + uri : base + uri;
    const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : "";
    return `${pre}${proxyOrigin}/api/player/proxy?url=${encodeURIComponent(absUri)}${refParam}${post}`;
  });
}

// Faz fetch server-side (sem CORS) e devolve o conteúdo pro browser
export async function GET(req: NextRequest) {
  // Exige sessão para evitar uso do servidor como open proxy anônimo.
  const session = await getServerSession(authOptions);
  if (!session?.user) return new NextResponse("Não autenticado", { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("url obrigatória", { status: 400 });

  // ref: Referer a enviar para o upstream (passado pela cadeia m3u8 → variante → segmento)
  const ref = req.nextUrl.searchParams.get("ref") ?? "";

  // Valida contra SSRF (scheme http/https, bloqueia IPs internos / metadata).
  let parsed: URL;
  try {
    parsed = await assertSafeUrl(url);
  } catch (e: any) {
    return new NextResponse(e?.message ?? "URL inválida", { status: 400 });
  }

  // Determina Referer/Origin: usa o param ?ref= se fornecido, senão o próprio domínio da URL
  const referer = ref || parsed.origin + "/";
  let refOrigin: string;
  try { refOrigin = new URL(referer).origin; } catch { refOrigin = parsed.origin; }

  // Deriva o Origin a spoofar: o origin do ?ref= (embed player) ou do próprio CDN como fallback.
  // Isso faz a request ao CDN parecer idêntica à que o embed player faria (same/cross-site XHR).
  let spoofedOrigin: string;
  try { spoofedOrigin = ref ? new URL(ref).origin : parsed.origin; } catch { spoofedOrigin = parsed.origin; }

  // Determina Sec-Fetch-Site: se ref é de domínio diferente do URL proxiado → cross-site
  const secFetchSite = spoofedOrigin !== parsed.origin ? "cross-site" : "same-origin";

  try {
    const headers: Record<string, string> = {
      "User-Agent": UA,
      "Accept": "*/*",
      "Accept-Language": "pt-BR,pt;q=0.5",
      "Origin": spoofedOrigin,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": secFetchSite,
      "Sec-GPC": "1",
    };
    if (referer && referer !== parsed.origin + "/") {
      headers["Referer"] = referer;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });

    if (!res.ok) {
      return new NextResponse(`Upstream error ${res.status}`, { status: res.status });
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const ct = contentType.toLowerCase();
    const isM3u8 =
      url.toLowerCase().includes(".m3u8") ||
      url.toLowerCase().includes(".txt") ||
      ct.includes("mpegurl");

    if (isM3u8) {
      // Reescreve o .m3u8 para que todos os segmentos também passem pelo proxy
      const text = await res.text();
      const base = url.substring(0, url.lastIndexOf("/") + 1);
      const proxyOrigin = req.nextUrl.origin;
      // Propaga o Referer atual para a próxima camada (variant → segmento usa o base da URL como ref)
      const nextRef = ref || base;

      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          // Reescreve URI em #EXT-X-KEY e #EXT-X-SESSION-KEY (chave AES-128)
          if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-SESSION-KEY")) {
            return rewriteAttrUri(line, "URI", base, parsed.origin, proxyOrigin, nextRef);
          }

          // Reescreve URI em #EXT-X-MEDIA (trilhas de áudio e legenda alternativas)
          if (trimmed.startsWith("#EXT-X-MEDIA")) {
            return rewriteAttrUri(line, "URI", base, parsed.origin, proxyOrigin, nextRef);
          }

          if (trimmed.startsWith("#")) return line;

          // Monta URL absoluta do segmento / variante
          let segUrl: string;
          if (trimmed.startsWith("http")) {
            segUrl = trimmed;
          } else if (trimmed.startsWith("/")) {
            segUrl = parsed.origin + trimmed;
          } else {
            segUrl = base + trimmed;
          }

          const refParam = nextRef ? `&ref=${encodeURIComponent(nextRef)}` : "";
          return `${proxyOrigin}/api/player/proxy?url=${encodeURIComponent(segUrl)}${refParam}`;
        })
        .join("\n");

      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        },
      });
    }

    // Segmento .ts ou outro binário — faz stream direto
    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });

  } catch (err: any) {
    return new NextResponse(err?.message ?? "erro interno", { status: 500 });
  }
}
