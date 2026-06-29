export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl } from "@/lib/ssrf";
import {
  resolveStreamToken,
  signSegmentUrl,
  verifySegmentUrl,
  isIpBlocked,
  recordAbuseAttempt,
} from "@/lib/playTokens";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// ── Helpers de contexto da requisição ────────────────────────────────────────

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

/** Nega silenciosamente com erro genérico */
function deny(reason: string, ip: string, status = 403): NextResponse {
  console.warn("[player/proxy] acesso negado:", reason, { ip });
  return new NextResponse("Acesso negado", { status });
}

// ── Reescrita de segmentos com HMAC ──────────────────────────────────────────

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

// ── Resolução do alvo da requisição ──────────────────────────────────────────

async function resolveTarget(
  req: NextRequest,
  userId: string,
  ip: string,
  ua: string,
): Promise<{ url: string; ref: string } | { denied: string }> {
  const params = req.nextUrl.searchParams;

  // Modo 1: stream token opaco (primeira requisição do player — busca o M3U8 mestre)
  const streamToken = params.get("t");
  if (streamToken) {
    const resolved = resolveStreamToken(streamToken, userId, ip, ua);
    if (!resolved) return { denied: "stream token inválido, expirado ou já consumido" };
    if (resolved.ipMismatch) {
      console.info("[player/proxy] IP mismatch no stream token (rede móvel?)", { userId, ip });
    }
    return { url: resolved.streamUrl, ref: resolved.referer ?? "" };
  }

  // Modo 2: segmento HMAC assinado (reescrita interna do M3U8)
  const rawUrl = params.get("url");
  const sig = params.get("sig");
  const ref = params.get("ref") ?? "";
  if (rawUrl && sig) {
    if (!verifySegmentUrl(rawUrl, userId, sig)) {
      return { denied: "assinatura de segmento inválida" };
    }
    return { url: rawUrl, ref };
  }

  return { denied: "parâmetros ausentes" };
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const ip = clientIp(req);
  const ua = clientUa(req);

  if (isIpBlocked(ip)) {
    return deny("IP bloqueado temporariamente", ip, 429);
  }

  // Valida Origin: requisições de fora do nosso domínio são rejeitadas.
  // Exclui ausência de Origin (navegadores omitem em navegação direta — segmentos HLS incluídos).
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !origin.includes(host)) {
    recordAbuseAttempt(ip);
    return deny(`origin inválida: ${origin}`, ip);
  }

  // Valida Referer quando presente: deve apontar para nosso domínio.
  const refererHeader = req.headers.get("referer");
  if (refererHeader && host && !refererHeader.includes(host)) {
    recordAbuseAttempt(ip);
    return deny(`referer externo: ${refererHeader.slice(0, 80)}`, ip);
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    recordAbuseAttempt(ip);
    return deny("não autenticado", ip, 401);
  }

  const userId = (session.user as { id: string }).id;
  if (!userId) return deny("sessão inválida", ip, 401);

  const target = await resolveTarget(req, userId, ip, ua);
  if ("denied" in target) {
    recordAbuseAttempt(ip);
    console.warn("[player/proxy] token rejeitado:", target.denied, { userId, ip, ua: ua.slice(0, 80) });
    return deny(target.denied, ip);
  }

  const { url, ref } = target;

  let parsed: URL;
  try {
    parsed = await assertSafeUrl(url);
  } catch (e: any) {
    console.error("[player/proxy] URL inválida na SSRF check:", e?.message);
    return deny("URL inválida", ip, 400);
  }

  const referer = ref || parsed.origin + "/";
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
      console.warn("[player/proxy] upstream error", { status: res.status, url: url.slice(0, 100) });
      return new NextResponse("Erro ao carregar conteúdo", { status: res.status });
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
    console.error("[player/proxy] erro interno:", err?.message);
    return new NextResponse("Erro interno", { status: 500 });
  }
}
