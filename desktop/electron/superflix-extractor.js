"use strict";

// Extrator nativo do SuperFlixAPI.
// Toda a cadeia roda no dispositivo do usuário (Electron), sem Vercel:
// SuperFlix -> Vizero -> WarezCDN -> player/source -> MP4/HLS final.

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_PAGE_HOPS = 7;

// Orçamento para inspecionar servidores antes de escolher. Cada fonte custa um POST
// em player/source mais uma leitura de manifesto; o limite evita que uma página com
// muitos servidores atrase demais o início da reprodução.
const PROBE_BUDGET_MS = 14000;

// Master HLS com várias qualidades e legendas — não vale a pena procurar mais.
const EXCELLENT_SCORE = 110;

const hlsManifest = require("./hls-manifest");

function slog(step, detail = "") {
  console.log(`[superflix/${step}]${detail ? ` ${detail}` : ""}`);
}

function safeUrlLabel(raw) {
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname}`.slice(0, 120);
  } catch {
    return String(raw).split("?")[0].slice(0, 120);
  }
}

function normalizeHtml(text) {
  return String(text || "")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function resolveUrl(candidate, baseUrl) {
  if (!candidate) return null;
  let value = normalizeHtml(candidate).trim();
  value = value.replace(/^['"]|['"]$/g, "");
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    try {
      return new URL(decodeURIComponent(value), baseUrl).toString();
    } catch {
      return null;
    }
  }
}

/**
 * O SuperFlix ainda publica algumas URLs absolutas como HTTP, embora o CDN aceite
 * HTTPS. Promove somente mídia e legendas, mantendo o resto da cadeia intacto.
 */
function secureTransportUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:") return parsed.toString();
    if (parsed.protocol !== "http:") return null;
    parsed.protocol = "https:";
    if (parsed.port === "80") parsed.port = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function isChainHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "superflixapi.pro" || host.endsWith(".superflixapi.pro") ||
    host.includes("vizero") || host.includes("warezcdn")
  );
}

function collectChainUrls(html, baseUrl) {
  const normalized = normalizeHtml(html);
  const found = [];
  const seen = new Set();

  const add = (raw) => {
    const candidate = normalizeHtml(raw).trim();
    // Páginas do SuperFlix contêm templates JavaScript como `${url}` e `${thumb}`.
    // Eles não são navegação real e consumiam o limite de hops até o erro
    // "cadeia excedeu o limite".
    if (/[${}]/.test(candidate)) return;
    const absolute = resolveUrl(candidate, baseUrl);
    if (!absolute || seen.has(absolute)) return;
    try {
      const parsed = new URL(absolute);
      // Scripts do desafio Cloudflare pertencem ao mesmo host, mas não são páginas
      // da cadeia SuperFlix/Vizero/WarezCDN.
      if (parsed.pathname.toLowerCase().startsWith("/cdn-cgi/")) return;
      const isSuperflix =
        parsed.hostname === "superflixapi.pro" || parsed.hostname.endsWith(".superflixapi.pro");
      if (isSuperflix && !parsed.searchParams.has("cfv") && !parsed.pathname.startsWith("/player/")) return;
      if (!isChainHost(parsed.hostname)) return;
      seen.add(absolute);
      found.push(absolute);
    } catch { /**/ }
  };

  for (const match of normalized.matchAll(/(?:src|data-src|href|data-url)\s*=\s*["']([^"']+)["']/gi)) {
    add(match[1]);
  }
  for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    add(match[0]);
  }

  return found.sort((a, b) => {
    const score = (url) => {
      let value = 0;
      try {
        const parsed = new URL(url);
        if (parsed.hostname.includes("warezcdn")) value += 100;
        if (parsed.searchParams.has("cfv")) value += 100;
        if (parsed.hostname.includes("vizero")) value += 50;
        if (parsed.pathname.includes("/player/")) value -= 30;
      } catch { /**/ }
      return value;
    };
    return score(b) - score(a);
  });
}

function decodeTokenPayload(token) {
  try {
    const part = token.split(".")[0];
    const pad = "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function findPageToken(html) {
  const normalized = normalizeHtml(html);
  const explicitPatterns = [
    /(?:page_token|pageToken)\s*[:=]\s*["']([^"']+)["']/i,
    /name=["']page_token["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']page_token["']/i,
    /data-page-token=["']([^"']+)["']/i,
    /page_token=([^&"'\s<]+)/i,
  ];

  for (const pattern of explicitPatterns) {
    const token = normalized.match(pattern)?.[1];
    if (token) return decodeURIComponent(token);
  }

  // Tanto cfv quanto page_token têm formato payload.assinatura. O page_token é
  // identificado pelos campos embed_content_path/embed_context_host do payload.
  const tokenPattern = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}/g;
  for (const match of normalized.matchAll(tokenPattern)) {
    const payload = decodeTokenPayload(match[0]);
    if (payload?.embed_content_path || payload?.embed_context_host || payload?.native_title) {
      return match[0];
    }
  }
  return null;
}

/**
 * Heurística de HTML usada apenas para decidir a ORDEM em que os servidores são
 * inspecionados. A escolha final vem de profileScore(), que mede o que cada
 * servidor realmente entregou.
 */
function sourceScore(id, context) {
  const text = String(context || "").toLowerCase();
  // O servidor alternativo costuma entregar HLS/HTTPS e é mais completo.
  // O servidor nativo permanece disponível como fallback.
  let score = id.startsWith("native_media:") ? 0 : 100;
  if (/dublad|portugu|pt-br/.test(text)) score += 40;
  if (/legend|subtitle|leg\b/.test(text)) score -= 10;
  if (/full\s*hd|1080|hd/.test(text)) score += 5;
  return score;
}

function findSourceIds(html) {
  const normalized = normalizeHtml(html);
  const items = new Map();

  const add = (id, index) => {
    const clean = String(id || "").trim();
    if (!/^(?:native_media:)?\d+$/.test(clean)) return;
    const context = normalized.slice(Math.max(0, index - 300), Math.min(normalized.length, index + 300));
    const score = sourceScore(clean, context);
    const previous = items.get(clean);
    if (!previous || score > previous.score) items.set(clean, { id: clean, score, index });
  };

  for (const match of normalized.matchAll(/native_media:\d+/gi)) add(match[0], match.index || 0);

  const patterns = [
    /(?:video[_-]?id|data-video-id|data-player-id|data-source-id|data-id)\s*[:=]\s*["']?((?:native_media:)?\d+)/gi,
    /name=["']video_id["'][^>]*value=["']((?:native_media:)?\d+)["']/gi,
    /value=["']((?:native_media:)?\d+)["'][^>]*name=["']video_id["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) add(match[1], match.index || 0);
  }

  return [...items.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.id);
}

function findNativeMediaSource(html, baseUrl) {
  const normalized = normalizeHtml(html);
  const arrayMatch = normalized.match(/var\s+SOURCES\s*=\s*(\[[\s\S]*?\])\s*;/i);
  if (arrayMatch) {
    try {
      const sources = JSON.parse(arrayMatch[1]);
      for (const source of sources) {
        const resolved = resolveUrl(source?.src, baseUrl);
        if (resolved?.includes("/player/native/media-source")) return resolved;
      }
    } catch { /**/ }
  }

  const match = normalized.match(/["'](https?:\/\/[^"']+\/player\/native\/media-source[^"']*)["']/i);
  return match ? resolveUrl(match[1], baseUrl) : null;
}

function findDirectMedia(html, baseUrl) {
  const normalized = normalizeHtml(html);
  const patterns = [
    /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i,
    /["'](https?:\/\/[^"']+\/cdn\/hls\/[^"']+\/master\.txt(?:\?[^"']*)?)["']/i,
    /(?:file|src|source)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const candidate = normalized.match(pattern)?.[1];
    const resolved = resolveUrl(candidate, baseUrl);
    const secure = resolved ? secureTransportUrl(resolved) : null;
    if (secure) return secure;
  }
  return null;
}

function findSubtitleTracks(html, baseUrl) {
  const normalized = normalizeHtml(html);
  const tracks = [];
  const seen = new Set();
  const add = (raw, label = "Português") => {
    const resolved = resolveUrl(raw, baseUrl);
    const file = resolved ? secureTransportUrl(resolved) : null;
    if (!file || seen.has(file) || !/\.(?:vtt|srt|ass|ssa)(?:$|\?)/i.test(file)) return;
    seen.add(file);
    tracks.push({ file, label: label || "Português", kind: "captions", default: tracks.length === 0, referer: baseUrl });
  };

  for (const match of normalized.matchAll(/<track\b[^>]*>/gi)) {
    const tag = match[0];
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const label = tag.match(/\blabel=["']([^"']+)["']/i)?.[1];
    if (src) add(src, label);
  }
  for (const match of normalized.matchAll(/(?:file|src)\s*:\s*["']([^"']+\.(?:vtt|srt|ass|ssa)(?:\?[^"']*)?)["'][\s\S]{0,160}?(?:label\s*:\s*["']([^"']+)["'])?/gi)) {
    add(match[1], match[2]);
  }
  for (const match of normalized.matchAll(/["'](https?:\/\/[^"']+\.(?:vtt|srt|ass|ssa)(?:\?[^"']*)?)["']/gi)) {
    add(match[1]);
  }
  return tracks;
}

function createCookieJar() {
  const cookies = new Map();

  function absorb(url, headers) {
    const host = new URL(url).hostname.toLowerCase();
    let values = [];
    if (typeof headers.getSetCookie === "function") values = headers.getSetCookie();
    if (!values.length) {
      const combined = headers.get("set-cookie");
      if (combined) {
        // Separa múltiplos Set-Cookie sem quebrar a vírgula do atributo Expires.
        values = combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
      }
    }

    for (const raw of values) {
      const parts = String(raw).split(";").map((p) => p.trim());
      const first = parts.shift();
      if (!first?.includes("=")) continue;
      const [name, ...rest] = first.split("=");
      let domain = host;
      for (const attr of parts) {
        const [key, ...valueParts] = attr.split("=");
        if (key.toLowerCase() === "domain" && valueParts.length) {
          domain = valueParts.join("=").replace(/^\./, "").toLowerCase();
        }
      }
      cookies.set(`${domain}|${name}`, { domain, name, value: rest.join("=") });
    }
  }

  function header(url) {
    const host = new URL(url).hostname.toLowerCase();
    return [...cookies.values()]
      .filter((cookie) => host === cookie.domain || host.endsWith(`.${cookie.domain}`))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  return { absorb, header };
}

function secFetchSite(url, referer) {
  if (!referer) return "none";
  try {
    return new URL(url).origin === new URL(referer).origin ? "same-origin" : "cross-site";
  } catch {
    return "cross-site";
  }
}

async function requestOnce(fetchImpl, jar, url, options) {
  const headers = {
    "User-Agent": options.ua,
    "Accept": options.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.7,en-US;q=0.3,en;q=0.2",
    "Sec-Fetch-Dest": options.dest || "iframe",
    "Sec-Fetch-Mode": options.mode || "navigate",
    "Sec-Fetch-Site": secFetchSite(url, options.referer),
    ...(options.headers || {}),
  };
  if (options.referer) headers.Referer = options.referer;
  const cookie = jar.header(url);
  if (cookie) headers.Cookie = cookie;

  const response = await fetchImpl(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  jar.absorb(url, response.headers);
  return response;
}

async function fetchPage(fetchImpl, jar, startUrl, options) {
  let url = startUrl;
  let referer = options.referer;
  let method = options.method || "GET";
  let body = options.body;
  let extraHeaders = options.headers || {};

  for (let hop = 0; hop < MAX_PAGE_HOPS; hop += 1) {
    const response = await requestOnce(fetchImpl, jar, url, {
      ...options,
      url,
      referer,
      method,
      body,
      headers: extraHeaders,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`redirect ${response.status} sem Location em ${safeUrlLabel(url)}`);
      const next = resolveUrl(location, url);
      if (!next) throw new Error(`Location inválido em ${safeUrlLabel(url)}`);
      referer = url;
      url = next;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        extraHeaders = {};
      }
      continue;
    }

    const text = options.readBody === false ? "" : await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${safeUrlLabel(url)}`);
    return { url, response, text };
  }
  throw new Error(`redirecionamentos demais em ${safeUrlLabel(startUrl)}`);
}

async function resolveWarezPage(fetchImpl, jar, embedUrl, ua, appReferer) {
  let current = embedUrl;
  let referer = appReferer;
  const visited = new Set();

  for (let hop = 0; hop < MAX_PAGE_HOPS; hop += 1) {
    if (visited.has(current)) throw new Error("loop na cadeia SuperFlix/Vizero/WarezCDN");
    visited.add(current);

    const page = await fetchPage(fetchImpl, jar, current, { ua, referer });
    const finalUrl = page.url;
    const parsed = new URL(finalUrl);
    slog("page", `hop=${hop} url=${safeUrlLabel(finalUrl)} bytes=${page.text.length}`);

    if (parsed.hostname.includes("warezcdn") && findPageToken(page.text)) {
      return { url: finalUrl, html: page.text };
    }

    const candidates = collectChainUrls(page.text, finalUrl).filter((url) => !visited.has(url));
    const next = candidates.find((url) => {
      try {
        const candidate = new URL(url);
        return candidate.hostname.includes("warezcdn") && candidate.searchParams.has("cfv");
      } catch { return false; }
    }) || candidates[0];

    if (!next) {
      // Alguns endpoints já entregam a página Warez sem mudar o hostname.
      if (findPageToken(page.text)) return { url: finalUrl, html: page.text };
      throw new Error(`iframe/redirect WarezCDN não encontrado em ${safeUrlLabel(finalUrl)}`);
    }

    referer = finalUrl;
    current = next;
  }
  throw new Error("cadeia SuperFlix excedeu o limite de páginas");
}

async function postSource(fetchImpl, jar, warezPage, pageToken, sourceId, host, ua) {
  const origin = new URL(warezPage.url).origin;
  const endpoint = `${origin}/player/source?host=${encodeURIComponent(host)}`;
  const form = new URLSearchParams({
    video_id: sourceId,
    page_token: pageToken,
    host,
    site: host,
    _token: "",
  });

  const response = await requestOnce(fetchImpl, jar, endpoint, {
    ua,
    method: "POST",
    referer: warezPage.url,
    dest: "empty",
    mode: "cors",
    accept: "*/*",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Origin": origin,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: form.toString(),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`player/source HTTP ${response.status}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("player/source retornou JSON inválido"); }
  const videoUrl = json?.data?.video_url || json?.video_url;
  if (!videoUrl) throw new Error("video_url ausente em player/source");
  return resolveUrl(videoUrl, endpoint);
}

async function resolveSource(fetchImpl, jar, targetUrl, warezPageUrl, host, ua, extractEmbedPlayer) {
  const first = await requestOnce(fetchImpl, jar, targetUrl, {
    ua,
    referer: warezPageUrl,
    readBody: false,
  });

  let resolvedUrl = targetUrl;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    resolvedUrl = resolveUrl(location, targetUrl);
    if (!resolvedUrl) throw new Error("player/redirect sem Location válido");
  } else if (!first.ok) {
    throw new Error(`player/redirect HTTP ${first.status}`);
  }

  const parsed = new URL(resolvedUrl);
  slog("target", safeUrlLabel(resolvedUrl));

  if (parsed.pathname.includes("/player/native/media/")) {
    const mediaPage = await fetchPage(fetchImpl, jar, resolvedUrl, {
      ua,
      referer: warezPageUrl,
    });
    const rawMediaSource = findNativeMediaSource(mediaPage.text, mediaPage.url);
    const subtitles = findSubtitleTracks(mediaPage.text, mediaPage.url);
    if (!rawMediaSource) throw new Error("media-source não encontrado no player nativo");
    const mediaSource = secureTransportUrl(rawMediaSource);
    if (!mediaSource) throw new Error("media-source sem transporte HTTPS");

    const mediaResponse = await requestOnce(fetchImpl, jar, mediaSource, {
      ua,
      referer: mediaPage.url,
      dest: "video",
      mode: "no-cors",
      accept: "*/*",
      headers: { Range: "bytes=0-0" },
      readBody: false,
    });

    if (mediaResponse.status >= 300 && mediaResponse.status < 400) {
      const redirected = resolveUrl(mediaResponse.headers.get("location"), mediaSource);
      const finalUrl = redirected ? secureTransportUrl(redirected) : null;
      if (!finalUrl) throw new Error("media-source sem Location final em HTTPS");
      return { stream: finalUrl, referer: null, tipo: looksLikeHlsUrl(finalUrl) ? "hls" : "mp4", subtitles };
    }

    const contentType = mediaResponse.headers.get("content-type") || "";
    if (mediaResponse.ok && /video\/mp4|octet-stream/i.test(contentType)) {
      return { stream: mediaSource, referer: mediaPage.url, tipo: "mp4", subtitles };
    }
    throw new Error(`media-source HTTP ${mediaResponse.status}`);
  }

  if (
    parsed.hostname.includes("embedplayer") ||
    parsed.hostname.includes("xn--kcksk7a2bl5le7b6doc1h3f") ||
    /\/video\/[a-f0-9]{16,}/i.test(parsed.pathname)
  ) {
    if (typeof extractEmbedPlayer !== "function") throw new Error("extrator embedplayer indisponível");
    // Legendas ficam no HTML do embed; sem elas o player abre só com o áudio.
    const subtitles = await fetchPage(fetchImpl, jar, resolvedUrl, { ua, referer: warezPageUrl })
      .then((page) => findSubtitleTracks(page.text, page.url))
      .catch(() => []);
    const raw = await extractEmbedPlayer(resolvedUrl, `${new URL(warezPageUrl).origin}/`);
    const stream = secureTransportUrl(raw);
    if (!stream) throw new Error("embedplayer sem transporte HTTPS");
    // tipo fica em aberto quando a URL não tem extensão: profileSource() resolve.
    return { stream, referer: resolvedUrl, tipo: looksLikeMp4Url(stream) ? "mp4" : null, subtitles };
  }

  if (/\.(?:mp4|m3u8)(?:$|\?)/i.test(resolvedUrl) || /\/master\.txt(?:$|\?)/i.test(resolvedUrl)) {
    const stream = secureTransportUrl(resolvedUrl);
    if (!stream) throw new Error("mídia direta sem transporte HTTPS");
    return {
      stream,
      referer: warezPageUrl,
      tipo: looksLikeMp4Url(stream) ? "mp4" : "hls",
      subtitles: [],
    };
  }

  const fallbackPage = await fetchPage(fetchImpl, jar, resolvedUrl, { ua, referer: warezPageUrl });
  const direct = findDirectMedia(fallbackPage.text, fallbackPage.url);
  if (!direct) throw new Error(`mídia não encontrada em ${safeUrlLabel(fallbackPage.url)}`);
  return {
    stream: direct,
    referer: fallbackPage.url,
    tipo: looksLikeMp4Url(direct) ? "mp4" : null,
    subtitles: findSubtitleTracks(fallbackPage.text, fallbackPage.url),
  };
}

function looksLikeHlsUrl(url) {
  return /\.m3u8(?:$|\?)/i.test(url) || /\/master\.txt(?:$|\?)/i.test(url) || /\/cdn\/hls\//i.test(url);
}

function looksLikeMp4Url(url) {
  return /\.mp4(?:$|\?)/i.test(url);
}

/**
 * Nota de qualidade real da fonte. Um master HLS vale mais que um HLS simples, que
 * vale mais que um MP4 — porque só o master carrega várias qualidades, faixas de
 * áudio e legendas para o JW Player montar os menus.
 */
function profileScore(tipo, info, hasSubtitles, sourceId) {
  let score;
  if (info?.isMaster) score = 70 + Math.min(info.variants.length, 5) * 6;
  else if (tipo === "hls") score = 45;
  else score = 20;

  if ((info?.audioTracks?.length || 0) >= 2) score += 35;
  if (hasSubtitles) score += 25;
  // Desempate: historicamente o servidor alternativo é o mais estável.
  if (!sourceId.startsWith("native_media:")) score += 3;
  return score;
}

/**
 * Descobre o que a fonte entrega sem baixar mídia à toa: quando a URL não denuncia
 * o formato, um Range de 1 byte revela o Content-Type; o corpo só é lido quando o
 * alvo é mesmo um manifesto.
 */
async function profileSource(fetchImpl, jar, sourceId, candidate, ua) {
  const url = candidate.stream;
  let tipo = candidate.tipo || (looksLikeHlsUrl(url) ? "hls" : looksLikeMp4Url(url) ? "mp4" : null);

  // O corpo só é lido quando há indício positivo de manifesto. Sem essa trava, uma
  // URL sem extensão classificada como HLS por padrão faria o extrator baixar o
  // filme inteiro para a memória.
  let readsManifest = tipo === "hls";

  if (!tipo) {
    const head = await requestOnce(fetchImpl, jar, url, {
      ua,
      referer: candidate.referer,
      accept: "*/*",
      dest: "video",
      mode: "no-cors",
      headers: { Range: "bytes=0-0" },
      readBody: false,
    }).catch(() => null);
    const contentType = (head?.headers.get("content-type") || "").toLowerCase();
    if (/mpegurl|m3u/.test(contentType)) {
      tipo = "hls";
      readsManifest = true;
    } else if (/mp4|octet-stream/.test(contentType)) {
      tipo = "mp4";
    } else {
      // Formato indefinido: mantém o padrão histórico ("hls"), mas sem tentar
      // interpretar o corpo.
      tipo = "hls";
    }
  }

  let info = null;
  if (readsManifest) {
    const manifest = await requestOnce(fetchImpl, jar, url, {
      ua,
      referer: candidate.referer,
      accept: "*/*",
      dest: "empty",
      mode: "cors",
    }).catch(() => null);
    if (manifest?.ok) {
      const body = await manifest.text().catch(() => "");
      if (hlsManifest.looksLikeManifest(body)) info = hlsManifest.parse(body, url);
    }
  }

  const subtitles = new Map();
  for (const track of candidate.subtitles || []) subtitles.set(track.file, track);
  // As legendas declaradas no master costumam apontar para uma sub-playlist .m3u8,
  // que o próprio hls.js resolve. Só um arquivo VTT/SRT direto pode virar `track` do
  // JW Player; o resto apenas conta como capacidade da fonte.
  for (const track of info?.subtitles || []) {
    if (!/\.(?:vtt|srt)(?:$|\?)/i.test(track.file)) continue;
    const file = secureTransportUrl(track.file);
    if (file && !subtitles.has(file)) {
      subtitles.set(file, { ...track, file, default: subtitles.size === 0, referer: candidate.referer });
    }
  }

  const hasSubtitles = subtitles.size > 0 || (info?.subtitles.length || 0) > 0;
  const score = profileScore(tipo, info, hasSubtitles, sourceId);
  slog(
    "profile",
    `source=${sourceId} tipo=${tipo} master=${Boolean(info?.isMaster)} ` +
      `qualidades=${info?.variants.length || 0} audios=${info?.audioTracks.length || 0} ` +
      `legendas=${subtitles.size} noManifesto=${info?.subtitles.length || 0} nota=${score}`,
  );

  return {
    sourceId,
    score,
    result: {
      ...candidate,
      tipo,
      subtitles: [...subtitles.values()],
      isMaster: Boolean(info?.isMaster),
      qualities: (info?.variants || []).map((variant) => variant.label),
      audioTracks: info?.audioTracks || [],
    },
  };
}

/** `exp` do token da cadeia, normalizado para epoch em milissegundos. */
function tokenExpiry(payload) {
  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp < 100000000000 ? exp * 1000 : exp;
}

async function extractSuperflix(embedUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch indisponível no Electron");

  const ua = options.ua || DEFAULT_UA;
  const appReferer = options.appReferer || "https://obaflix.vercel.app/";
  const jar = createCookieJar();

  const input = new URL(embedUrl);
  if (!input.hostname.endsWith("superflixapi.pro")) {
    throw new Error("URL SuperFlix inválida");
  }

  const warezPage = await resolveWarezPage(fetchImpl, jar, embedUrl, ua, appReferer);
  const pageToken = findPageToken(warezPage.html);
  if (!pageToken) throw new Error("page_token não encontrado na página WarezCDN");

  const tokenPayload = decodeTokenPayload(pageToken) || {};
  const host = tokenPayload.embed_context_host || new URL(warezPage.url).searchParams.get("host") || "vizero.buzz";
  const sourceIds = findSourceIds(warezPage.html);
  if (!sourceIds.length) throw new Error("nenhum video_id encontrado na página WarezCDN");

  slog("sources", `total=${sourceIds.length} native=${sourceIds.filter((id) => id.startsWith("native_media:")).length}`);

  const failures = [];
  const profiles = [];
  const expiresAt = tokenExpiry(tokenPayload);
  const probeDeadline = Date.now() + PROBE_BUDGET_MS;

  // Inspeciona os servidores em vez de aceitar o primeiro que responde: o primeiro
  // funcional costuma ser um MP4 de qualidade única, enquanto outro servidor entrega
  // um master HLS com qualidades, áudio e legendas.
  for (const sourceId of sourceIds) {
    try {
      const targetUrl = await postSource(fetchImpl, jar, warezPage, pageToken, sourceId, host, ua);
      if (!targetUrl) throw new Error("video_url inválida");
      const candidate = await resolveSource(
        fetchImpl,
        jar,
        targetUrl,
        warezPage.url,
        host,
        ua,
        options.extractEmbedPlayer,
      );
      const profile = await profileSource(fetchImpl, jar, sourceId, candidate, ua);
      profiles.push(profile);
      if (profile.score >= EXCELLENT_SCORE) {
        slog("probe_stop", `fonte completa encontrada em ${sourceId}`);
        break;
      }
    } catch (error) {
      const message = error?.message || String(error);
      failures.push(`${sourceId}: ${message}`);
      slog("source_skip", `source=${sourceId} erro=${message.slice(0, 100)}`);
    }
    if (Date.now() > probeDeadline && profiles.length) {
      slog("probe_stop", `orçamento de inspeção esgotado com ${profiles.length} fonte(s)`);
      break;
    }
  }

  if (!profiles.length) {
    throw new Error(`todas as fontes SuperFlix falharam: ${failures.join(" | ").slice(0, 500)}`);
  }

  const best = profiles.reduce((a, b) => (b.score > a.score ? b : a));
  slog(
    "ok",
    `escolhida=${best.sourceId.startsWith("native_media:") ? "native" : "embed"} ` +
      `nota=${best.score} entre=${profiles.length} tipo=${best.result.tipo} ` +
      `host=${safeUrlLabel(best.result.stream)}`,
  );
  return { ...best.result, expiresAt };
}

module.exports = {
  extractSuperflix,
  // Exportado apenas para testes locais do parser; não é usado pelo app.
  _test: {
    normalizeHtml,
    collectChainUrls,
    findPageToken,
    findSourceIds,
    findNativeMediaSource,
    findDirectMedia,
    findSubtitleTracks,
    decodeTokenPayload,
    secureTransportUrl,
    profileScore,
    tokenExpiry,
    looksLikeHlsUrl,
    looksLikeMp4Url,
  },
};
