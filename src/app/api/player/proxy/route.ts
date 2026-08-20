export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertSafeUrl, safeGet } from "@/lib/ssrf";
import { headerMatchesHost } from "@/lib/requestSecurity";
import {
  resolveStreamToken,
  signSegmentUrl,
  verifySegmentUrl,
  isIpBlocked,
  recordAbuseAttempt,
} from "@/lib/playTokens";
import { audit } from "@/lib/auditLog";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function rid() { return Math.random().toString(36).slice(2, 10); }
function plog(id: string, step: string, extra?: Record<string, unknown>) {
  const parts = Object.entries(extra ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(" ");
  console.log(`[proxy/${step}] rid=${id}${parts ? " " + parts : ""}`);
}
/** Remove query string de URLs nos logs — tokens (cnvs_token, verify, sig) nunca ficam em log. */
function sanitizeUrl(url: string, maxLen = 80): string {
  try {
    const p = new URL(url);
    return `${p.hostname}${p.pathname}`.slice(0, maxLen);
  } catch {
    const qi = url.indexOf("?");
    return (qi !== -1 ? url.slice(0, qi) : url).slice(0, maxLen);
  }
}

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

/**
 * Os bytes pesados de mídia devem ir do CDN diretamente para o dispositivo.
 * Playlists, chaves e trilhas alternativas ainda passam pelo proxy autenticado,
 * mas segmentos TS/fMP4 não consomem Fast Origin Transfer da Vercel.
 *
 * Android/Electron continuam buscando no CDN pelo IP do aparelho. Navegadores
 * comuns precisam do proxy same-origin porque os CDNs atuais bloqueiam CORS.
 * MEDIA_SEGMENT_DELIVERY=direct|proxy permite forçar um dos modos.
 */
function shouldProxyMediaThroughApp(ua: string): boolean {
  const configured = process.env.MEDIA_SEGMENT_DELIVERY?.toLowerCase();
  if (configured === "proxy") return true;
  if (configured === "direct") return false;
  return !/(?:ObaflixApp\/|Electron\/)/i.test(ua);
}

/** Nega silenciosamente com erro genérico */
function deny(reason: string, ip: string, event: Parameters<typeof audit>[0] = "stream_rejected", status = 403): NextResponse {
  audit(event, { ip, detail: reason });
  return new NextResponse("Acesso negado", { status, headers: NO_STORE });
}

// ── Reescrita HLS ────────────────────────────────────────────────────────────

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

function rewriteAttrUriDirect(line: string, attr: string, base: string, parsedOrigin: string): string {
  const re = new RegExp(`(${attr}=")([^"]+)(")`);
  return line.replace(re, (_, pre, uri: string, post) => {
    const absUri = uri.startsWith("http") ? uri : uri.startsWith("/") ? parsedOrigin + uri : base + uri;
    return `${pre}${absUri}${post}`;
  });
}

/**
 * Reescreve uma playlist HLS de acordo com o ambiente:
 * - playlists, chaves e trilhas alternativas passam pelo proxy autenticado;
 * - no navegador, mapas e segmentos também passam pelo proxy same-origin;
 * - no Electron e Android, mapas e segmentos continuam diretos pelo CDN.
 */
function rewriteHlsPlaylist(
  text: string,
  sourceUrl: string,       // URL original da playlist (para resolver paths relativos)
  parsedOrigin: string,    // origem do CDN (ex: "https://cdn.example.com")
  proxyOrigin: string,     // origem do nosso app (req.nextUrl.origin)
  ref: string,
  userId: string,
  proxyMediaThroughApp: boolean,
): string {
  const base = sourceUrl.endsWith("/")
    ? sourceUrl
    : sourceUrl.substring(0, sourceUrl.lastIndexOf("/") + 1);

  let prevTag = "";

  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-SESSION-KEY")) {
        prevTag = "#EXT-X-KEY";
        return rewriteAttrUri(line, "URI", base, parsedOrigin, proxyOrigin, ref, userId);
      }
      if (trimmed.startsWith("#EXT-X-MEDIA")) {
        prevTag = "#EXT-X-MEDIA";
        return rewriteAttrUri(line, "URI", base, parsedOrigin, proxyOrigin, ref, userId);
      }

      // Recursos de mídia declarados em URI="..." ficam absolutos no modo
      // direto; no fallback, continuam assinados pelo proxy same-origin.
      if (trimmed.startsWith("#") && /\bURI="/.test(trimmed)) {
        prevTag = trimmed.split(":")[0];
        return proxyMediaThroughApp
          ? rewriteAttrUri(line, "URI", base, parsedOrigin, proxyOrigin, ref, userId)
          : rewriteAttrUriDirect(line, "URI", base, parsedOrigin);
      }

      if (trimmed.startsWith("#EXT-X-MAP")) {
        // Segmento de inicialização (fMP4): resolve para URL absoluta direta (sem proxy)
        prevTag = "#EXT-X-MAP";
        return line.replace(/URI="([^"]+)"/, (_, uri) => {
          const abs = uri.startsWith("http") ? uri : uri.startsWith("/") ? parsedOrigin + uri : base + uri;
          return `URI="${abs}"`;
        });
      }
      if (trimmed.startsWith("#")) {
        prevTag = trimmed.split(":")[0];
        return line;
      }

      // Resolve URL absoluta
      let absUrl: string;
      if (trimmed.startsWith("http")) absUrl = trimmed;
      else if (trimmed.startsWith("/")) absUrl = parsedOrigin + trimmed;
      else absUrl = base + trimmed;

      const tag = prevTag;
      prevTag = "";

      // Sub-playlist (após #EXT-X-STREAM-INF) → proxy com HMAC (mantém auth gate)
      if (tag === "#EXT-X-STREAM-INF") {
        const sig = signSegmentUrl(absUrl, userId);
        const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : "";
        return `${proxyOrigin}/api/player/proxy?url=${encodeURIComponent(absUrl)}&sig=${sig}${refParam}`;
      }

      // Navegador comum: passa pelo proxy para manter same-origin e enviar
      // os cabeçalhos exigidos pelo CDN.
      if (proxyMediaThroughApp) {
        const sig = signSegmentUrl(absUrl, userId);
        const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : "";
        return `${proxyOrigin}/api/player/proxy?url=${encodeURIComponent(absUrl)}&sig=${sig}${refParam}`;
      }

      // Electron e Android continuam buscando diretamente no CDN.
      return absUrl;
    })
    .join("\n");
}

// ── Resolução do alvo da requisição ──────────────────────────────────────────

async function resolveTarget(
  req: NextRequest,
  userId: string,
  ip: string,
  ua: string,
): Promise<{ url: string; ref: string; manifest?: string } | { denied: string }> {
  const params = req.nextUrl.searchParams;

  // Modo 1: stream token opaco (primeira requisição do player — busca o M3U8 mestre)
  const streamToken = params.get("t");
  if (streamToken) {
    const resolved = await resolveStreamToken(streamToken, userId, ip, ua);
    if (!resolved) return { denied: "stream token inválido, expirado ou já consumido" };
    if (resolved.ipMismatch) {
      audit("stream_started", { userId, ip, ua, detail: "IP mismatch (rede móvel — permitido)" });
    }
    return { url: resolved.streamUrl, ref: resolved.referer ?? "", manifest: resolved.manifest };
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
  const id = rid();
  const ip = clientIp(req);
  const ua = clientUa(req);
  const proxyMediaThroughApp = shouldProxyMediaThroughApp(ua);
  const mode = req.nextUrl.searchParams.has("t") ? "token" : req.nextUrl.searchParams.has("url") ? "segment" : "unknown";
  plog(id, "start", { mode, ip: ip.slice(0, 16) });

  if (await isIpBlocked(ip)) {
    plog(id, "reject", { reason: "ip_blocked" });
    return deny("IP bloqueado temporariamente", ip, "ip_blocked", 429);
  }

  // Valida Origin: requisições de fora do nosso domínio são rejeitadas.
  // Exclui ausência de Origin (navegadores omitem em navegação direta — segmentos HLS incluídos).
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    plog(id, "reject", { reason: "origin_mismatch", origin, host });
    await recordAbuseAttempt(ip);
    return deny(`origin inválida: ${origin}`, ip, "origin_rejected");
  }

  const refererHeader = req.headers.get("referer");
  if (refererHeader && host && !headerMatchesHost(refererHeader, host)) {
    plog(id, "reject", { reason: "referer_external", referer: refererHeader.slice(0, 60) });
    await recordAbuseAttempt(ip);
    return deny(`referer externo: ${refererHeader.slice(0, 80)}`, ip, "origin_rejected");
  }

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    plog(id, "reject", { reason: "no_session" });
    await recordAbuseAttempt(ip);
    audit("auth_failure", { ip, ua, detail: "/proxy sem sessão" });
    return deny("não autenticado", ip, "stream_rejected", 401);
  }

  const userId = (session.user as { id: string }).id;
  if (!userId) {
    plog(id, "reject", { reason: "no_userid" });
    return deny("sessão inválida", ip, "stream_rejected", 401);
  }
  plog(id, "auth_ok", { uid: userId.slice(-8) });

  let target: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    target = await resolveTarget(req, userId, ip, ua);
  } catch (err: any) {
    plog(id, "reject", { reason: "resolve_exception", err: String(err?.message).slice(0, 80) });
    console.error("[player/proxy] erro ao resolver alvo:", err?.message);
    return new NextResponse("Erro interno ao resolver stream", { status: 500, headers: NO_STORE });
  }
  if ("denied" in target) {
    plog(id, "reject", { reason: "resolve_denied", detail: target.denied });
    await recordAbuseAttempt(ip);
    return deny(target.denied, ip, "stream_rejected");
  }

  const { url, ref, manifest } = target;
  plog(id, "resolved", { url: sanitizeUrl(url), ref: sanitizeUrl(ref || ""), hasManifest: !!manifest });

  // Manifest inline: extraído durante o extract na mesma instância/IP do CDN.
  // Serve direto sem ir ao CDN, evitando falha de IP-bound md5 (403 upstream).
  if (manifest) {
    let cdnOrigin: string;
    try { cdnOrigin = new URL(url).origin; } catch { cdnOrigin = "https://unknown.invalid"; }
    const nextRef = ref || url.substring(0, url.lastIndexOf("/") + 1);
    const rewritten = rewriteHlsPlaylist(
      manifest,
      url,
      cdnOrigin,
      req.nextUrl.origin,
      nextRef,
      userId,
      proxyMediaThroughApp,
    );
    plog(id, "MASTER_INLINE", { bytes: manifest.length, lines: rewritten.split("\n").length });
    return new NextResponse(rewritten, {
      status: 200,
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store, no-cache, must-revalidate, private" },
    });
  }

  let parsed: URL;
  try {
    parsed = await assertSafeUrl(url);
  } catch (e: any) {
    plog(id, "reject", { reason: "ssrf", err: String(e?.message).slice(0, 60) });
    audit("stream_rejected", { ip, detail: `SSRF: ${String(e?.message).slice(0, 80)}` });
    return deny("URL inválida", ip, "stream_rejected", 400);
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

    plog(id, "fetch_start", { host: parsed.hostname, referer: (headers["Referer"] ?? "—").slice(0, 60), origin: spoofedOrigin.slice(0, 60) });

    const res = await safeGet(url, {
      headers,
      signal: AbortSignal.timeout(20000),
    });

    plog(id, "fetch_done", { status: res.status, ct: res.headers.get("content-type")?.slice(0, 40) ?? "—" });

    if (!res.ok) {
      const rangeHdr = req.headers.get("range");
      const cnvsMatch = url.match(/cnvs_token=(\d+)-/);
      const cnvsAgeS = cnvsMatch ? Math.floor((Date.now() - parseInt(cnvsMatch[1]) * 1000) / 1000) : null;
      plog(id, "upstream_error", {
        status: res.status,
        host: parsed.hostname,
        range: rangeHdr ? "yes" : "no",
        ...(cnvsAgeS !== null ? { cnvs_token_age_s: cnvsAgeS } : {}),
        url: sanitizeUrl(url, 100),
      });
      return new NextResponse("Erro ao carregar conteúdo", { status: res.status });
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const ct = contentType.toLowerCase();
    // O EmbedPlayer usa playlists HLS sem extensão: /m3/... para vídeo/áudio
    // e /md/... para a playlist de legendas. O MIME retornado é text/plain.
    const extensionlessProviderPlaylist =
      (parsed.hostname === "embedplayer2.xyz" || parsed.hostname.endsWith(".embedplayer2.xyz") ||
       parsed.hostname === "embedplayer1.xyz" || parsed.hostname.endsWith(".embedplayer1.xyz")) &&
      /^\/m(?:3|d)\//i.test(parsed.pathname);
    const isSubtitlePlaylist = extensionlessProviderPlaylist && /^\/md\//i.test(parsed.pathname);
    const isM3u8 =
      url.toLowerCase().includes(".m3u8") ||
      url.toLowerCase().includes(".txt") ||
      ct.includes("mpegurl") ||
      extensionlessProviderPlaylist;

    if (isM3u8) {
      const text = await res.text();
      const isMaster = text.includes("#EXT-X-STREAM-INF");
      const nextRef = ref || url.substring(0, url.lastIndexOf("/") + 1);
      plog(id, isMaster ? "MASTER_UPSTREAM" : "VARIANT_UPSTREAM", { host: parsed.hostname, bytes: text.length });
      const rewritten = rewriteHlsPlaylist(
        text,
        url,
        parsed.origin,
        req.nextUrl.origin,
        nextRef,
        userId,
        proxyMediaThroughApp || isSubtitlePlaylist,
      );
      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store, no-cache, must-revalidate, private",
        },
      });
    }

    const contentLengthVal = res.headers.get("content-length");
    plog(id, "SEGMENT_UPSTREAM", {
      host: parsed.hostname,
      status: res.status,
      ct: contentType.slice(0, 40),
      bytes: contentLengthVal ?? "unknown",
    });

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
