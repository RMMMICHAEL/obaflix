export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl } from "@/lib/ssrf";
import { resolveStreamToken, signSegmentUrl, verifySegmentUrl } from "@/lib/playTokens";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function rewriteAttrUri(
  line: string, attr: string, base: string, parsedOrigin: string,
  proxyOrigin: string, ref: string, userId: string,
): string {
  const re = new RegExp(`(${attr}=")([^"]+)(")`);
  return line.replace(re, (_, pre, uri: string, post) => {
    const absUri = uri.startsWith("http") ? uri : uri.startsWith("/") ? parsedOrigin + uri : base + uri;
    const sig = signSegmentUrl(absUri, userId);
    const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : "";
    return `${pre}${proxyOrigin}/api/player/proxy?url=${encodeURIComponent(absUri)}&sig=${sig}${refParam}${post}`;
  });
}

async function resolveTarget(req: NextRequest, session: { user: { id: string } }): Promise<
  { url: string; ref: string } | null
> {
  const userId = session.user.id;
  const params = req.nextUrl.searchParams;

  // Modo 1: stream token opaco (primeira requisição do player)
  const streamToken = params.get("t");
  if (streamToken) {
    const resolved = resolveStreamToken(streamToken, userId);
    if (!resolved) return null;
    return { url: resolved.streamUrl, ref: resolved.referer ?? "" };
  }

  // Modo 2: segmento assinado com HMAC (reescrita interna do M3U8)
  const rawUrl = params.get("url");
  const sig = params.get("sig");
  const ref = params.get("ref") ?? "";
  if (rawUrl && sig) {
    if (!verifySegmentUrl(rawUrl, userId, sig)) return null;
    return { url: rawUrl, ref };
  }

  return null;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return new NextResponse("Não autenticado", { status: 401 });

  const userId = (session.user as { id: string }).id;
  if (!userId) return new NextResponse("Sessão inválida", { status: 401 });

  const target = await resolveTarget(req, { user: { id: userId } });
  if (!target) return new NextResponse("Token inválido ou expirado", { status: 403 });

  const { url, ref } = target;

  let parsed: URL;
  try {
    parsed = await assertSafeUrl(url);
  } catch (e: any) {
    return new NextResponse(e?.message ?? "URL inválida", { status: 400 });
  }

  const referer = ref || parsed.origin + "/";
  let refOrigin: string;
  try { refOrigin = new URL(referer).origin; } catch { refOrigin = parsed.origin; }

  let spoofedOrigin: string;
  try { spoofedOrigin = ref ? new URL(ref).origin : parsed.origin; } catch { spoofedOrigin = parsed.origin; }

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

    const rangeHeader = req.headers.get("range");
    if (rangeHeader) headers["Range"] = rangeHeader;

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
      const text = await res.text();
      const base = url.substring(0, url.lastIndexOf("/") + 1);
      const proxyOrigin = req.nextUrl.origin;
      const nextRef = ref || base;

      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-SESSION-KEY")) {
            return rewriteAttrUri(line, "URI", base, parsed.origin, proxyOrigin, nextRef, userId);
          }
          if (trimmed.startsWith("#EXT-X-MEDIA")) {
            return rewriteAttrUri(line, "URI", base, parsed.origin, proxyOrigin, nextRef, userId);
          }
          if (trimmed.startsWith("#")) return line;

          let segUrl: string;
          if (trimmed.startsWith("http")) {
            segUrl = trimmed;
          } else if (trimmed.startsWith("/")) {
            segUrl = parsed.origin + trimmed;
          } else {
            segUrl = base + trimmed;
          }

          const sig = signSegmentUrl(segUrl, userId);
          const refParam = nextRef ? `&ref=${encodeURIComponent(nextRef)}` : "";
          return `${proxyOrigin}/api/player/proxy?url=${encodeURIComponent(segUrl)}&sig=${sig}${refParam}`;
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

    const responseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    const contentRange = res.headers.get("content-range");
    if (contentRange) responseHeaders["Content-Range"] = contentRange;
    const contentLength = res.headers.get("content-length");
    if (contentLength) responseHeaders["Content-Length"] = contentLength;

    return new NextResponse(res.body, {
      status: res.status,
      headers: responseHeaders,
    });

  } catch (err: any) {
    return new NextResponse(err?.message ?? "erro interno", { status: 500 });
  }
}
