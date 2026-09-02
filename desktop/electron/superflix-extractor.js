"use strict";

// Extrator nativo do SuperFlixAPI.
// Toda a cadeia roda no dispositivo do usuário (Electron), sem Vercel:
// SuperFlix -> Vizero -> WarezCDN -> player/source -> MP4/HLS final.

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";

// O provedor migrou de superflixapi.pro para superflixapi.sbs; o antigo ainda
// responde 301 e aparece em URLs gravadas, entao os dois seguem aceitos.
// O provedor migrou de superflixapi.pro para superflixapi.sbs; o antigo ainda
// responde 301 e aparece em URLs gravadas, então os dois seguem aceitos.
//
// Os pontos precisam de escape: sem eles "." casa qualquer caractere e um
// domínio parecido (notsuperflixapiXpro) passaria na checagem.
const EH_SUPERFLIX = /(^|\.)superflixapi\.(pro|sbs|beer)$/i;

// O host punycode do EmbedPlayer troca de domínio periodicamente. Manter os
// conhecidos aqui evita caçar cada checagem por substring espalhada no arquivo.
//   xn--kcksk7a2bl5le7b6doc1h3f.com      シャオリンマタドールデポルコ.com
//   xn--tckasiu6cvova0eb5fua2449g98vg.best  ココ・レストラン予約センター.best
const PUNYCODE_EMBEDPLAYER = /xn--kcksk7a2bl5le7b6doc1h3f|xn--tckasiu6cvova0eb5fua2449g98vg/i;

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_PAGE_HOPS = 7;

// Orçamento para inspecionar servidores antes de escolher. Cada fonte custa um POST
// em player/source mais uma leitura de manifesto; o limite evita que uma página com
// muitos servidores atrase demais o início da reprodução.
const PROBE_BUDGET_MS = 14000;

// Teto de servidores inspecionados. Sem ele, uma página com 10 servidores mortos
// gastava 10 × (POST + até 7 hops + manifesto) antes de desistir — era esse o
// caminho que fazia a extração levar dezenas de segundos.
const MAX_PROBED_SOURCES = 5;

// Timeout por requisição durante a inspeção. Mais curto que o DEFAULT_TIMEOUT_MS
// porque aqui estamos sondando alternativas, não carregando a fonte definitiva:
// um servidor que não responde em 6 s não é o que vai iniciar a reprodução rápido.
const PROBE_TIMEOUT_MS = 6000;

// Master HLS com várias qualidades e legendas — não vale a pena procurar mais.
const EXCELLENT_SCORE = 110;

// Nota a partir da qual a fonte já é boa o bastante para começar a tocar. Continuar
// procurando acima disso troca segundos de espera por um ganho marginal.
const GOOD_ENOUGH_SCORE = 76;

const hlsManifest = require("./hls-manifest");
const { randomUUID } = require("crypto");

// O extrator também roda fora do Electron (scripts de diagnóstico), então o logger
// é opcional: sem ele, cai no console como antes.
let log = null;
try { log = require("./logger"); } catch { /* fora do app */ }

function slog(step, detail = "") {
  if (log) log.debug(`superflix.${step}`, detail || "-");
  else console.log(`[superflix/${step}]${detail ? ` ${detail}` : ""}`);
}

class SuperflixAuthorizationError extends Error {
  constructor(message, { status = null, stage = "authorization" } = {}) {
    super(message);
    this.name = "SuperflixAuthorizationError";
    this.status = status;
    this.stage = stage;
    this.code = "SUPERFLIX_AUTH_REQUIRED";
  }
}

class SuperflixNativeOptionExpiredError extends Error {
  constructor(stage = "native-media") {
    super("opção nativa Superflix expirada");
    this.name = "SuperflixNativeOptionExpiredError";
    this.stage = stage;
    this.code = "SUPERFLIX_NATIVE_OPTION_EXPIRED";
  }
}

function isAuthorizationError(error) {
  return error?.code === "SUPERFLIX_AUTH_REQUIRED" ||
    error instanceof SuperflixAuthorizationError;
}

function isNativeOptionExpiredError(error) {
  return error?.code === "SUPERFLIX_NATIVE_OPTION_EXPIRED" ||
    error instanceof SuperflixNativeOptionExpiredError;
}

function hasExpiredNativeOption(body) {
  return /Expired native media option/i.test(String(body || ""));
}

function isAuthorizationStatus(status) {
  return status === 403 || status === 419;
}

function isCloudflareChallenge(html) {
  return /cf_embed_challenge|cf_chl_|challenge-running|challenges\.cloudflare\.com|turnstile|just a moment/i
    .test(String(html || ""));
}

function httpError(stage, response, url, body = "") {
  if (isAuthorizationStatus(response.status) || isCloudflareChallenge(body)) {
    return new SuperflixAuthorizationError(`${stage} requer nova autorização`, {
      status: response.status,
      stage,
    });
  }
  return new Error(`${stage} HTTP ${response.status} em ${safeUrlLabel(url)}`);
}

function safeUrlLabel(raw) {
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname}`.slice(0, 120);
  } catch {
    return String(raw).split("?")[0].slice(0, 120);
  }
}

function resolutionRouteKind(raw) {
  try {
    const pathname = new URL(raw).pathname;
    if (pathname === "/player/source") return "source";
    if (pathname.startsWith("/player/redirect")) return "redirect";
    if (pathname.startsWith("/video/")) return "video";
    if (pathname === "/player/index.php") return "index";
  } catch { /**/ }
  return null;
}

/** Instrumentação temporária sem URL, query, cookie ou identidade interna. */
function createResolutionAttemptTrace(optionKey, resolutionAttemptId = randomUUID()) {
  const counts = { source: 0, redirect: 0, video: 0, index: 0 };
  const statuses = [];
  let cookieJarUpdated = false;
  let finished = false;
  const safeOptionKey = String(optionKey || "-").slice(0, 128);

  slog("resolution_start", `attempt=${resolutionAttemptId} option=${safeOptionKey}`);
  return {
    id: resolutionAttemptId,
    optionKey: safeOptionKey,
    record(rawUrl, status, jarUpdated = false) {
      const route = resolutionRouteKind(rawUrl);
      if (!route) return;
      counts[route] += 1;
      cookieJarUpdated ||= Boolean(jarUpdated);
      statuses.push({ route, status: Number(status) || 0, cookieJarUpdated: Boolean(jarUpdated) });
      slog(
        "resolution_http",
        `attempt=${resolutionAttemptId} option=${safeOptionKey} route=${route} count=${counts[route]} ` +
          `status=${Number(status) || 0} cookie_jar_updated=${Boolean(jarUpdated)}`,
      );
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      slog(
        "resolution_end",
        `attempt=${resolutionAttemptId} option=${safeOptionKey} outcome=${outcome} ` +
          `source=${counts.source} redirect=${counts.redirect} video=${counts.video} index=${counts.index} ` +
          `cookie_jar_updated=${cookieJarUpdated}`,
      );
    },
    snapshot() {
      return { counts: { ...counts }, statuses: [...statuses], cookieJarUpdated };
    },
  };
}

function shareInFlightResolution(inFlight, key, operation, onReuse) {
  const existing = inFlight.get(key);
  if (existing) {
    if (typeof onReuse === "function") onReuse(existing);
    return existing;
  }
  let shared;
  shared = Promise.resolve()
    .then(operation)
    .finally(() => {
      if (inFlight.get(key) === shared) inFlight.delete(key);
    });
  inFlight.set(key, shared);
  return shared;
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
    EH_SUPERFLIX.test(host) ||
    host.includes("vizer") || host.includes("warezcdn")
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
        EH_SUPERFLIX.test(parsed.hostname);
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
        if (parsed.hostname.includes("vizer")) value += 50;
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

// Aceita o ID numérico simples, o `native_media:123` antigo e o
// `native_media_v2:262627:131927:1:1:171230:<md5>` atual. A validação anterior
// exigia dígitos após o prefixo e descartava todos os servidores nativos novos.
const SOURCE_ID_PATTERN = /^(?:native_media(?:_v\d+)?:[A-Za-z0-9:_-]+|\d+)$/;

/** Servidor incorporado em vez de arquivo MP4 direto. */
function ehServidorIncorporado(option) {
  if (typeof option.isFile === "boolean") return !option.isFile;
  return !option.id.startsWith("native_media");
}

function findSourceIds(html) {
  const normalized = normalizeHtml(html);
  const items = new Map();

  const add = (id, index) => {
    const clean = String(id || "").trim();
    if (!SOURCE_ID_PATTERN.test(clean)) return;
    const context = normalized.slice(Math.max(0, index - 300), Math.min(normalized.length, index + 300));
    const score = sourceScore(clean, context);
    const previous = items.get(clean);
    if (!previous || score > previous.score) items.set(clean, { id: clean, score, index });
  };

  for (const match of normalized.matchAll(/native_media(?:_v\d+)?:[A-Za-z0-9:_-]+/gi)) {
    add(match[0], match.index || 0);
  }

  const patterns = [
    /(?:video[_-]?id|data-video-id|data-player-id|data-source-id|data-id)\s*[:=]\s*["']?((?:native_media(?:_v\d+)?:)?[A-Za-z0-9:_-]+)/gi,
    /name=["']video_id["'][^>]*value=["']((?:native_media(?:_v\d+)?:)?[A-Za-z0-9:_-]+)["']/gi,
    /value=["']((?:native_media(?:_v\d+)?:)?[A-Za-z0-9:_-]+)["'][^>]*name=["']video_id["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) add(match[1], match.index || 0);
  }

  return [...items.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.id);
}

/**
 * `contentid` que /player/bootstrap exige. É um identificador interno do
 * SuperFlix — não é o TMDB nem o `embed_item_id` do token — então só resta
 * procurá-lo na página.
 */
function findContentId(html) {
  const normalized = normalizeHtml(html);
  const patterns = [
    /["']?content[_-]?id["']?\s*[:=]\s*["']?(\d{2,12})/i,
    /name=["']contentid["'][^>]*value=["'](\d{2,12})["']/i,
    /value=["'](\d{2,12})["'][^>]*name=["']contentid["']/i,
    /data-content-id=["'](\d{2,12})["']/i,
    /contentid=(\d{2,12})/i,
  ];
  for (const pattern of patterns) {
    const found = normalized.match(pattern)?.[1];
    if (found) return found;
  }
  return null;
}

/** Extrai tipo/temporada/episódio de um caminho como /serie/dexter/1/1 ou /filme/xxx. */
function contentCoordinates(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  const primeiro = (parts[0] || "").toLowerCase();
  const tipo = primeiro === "serie" || primeiro === "filme" ? primeiro : "filme";
  if (tipo !== "serie") return { tipo, season: null, episode: null };
  return { tipo, season: parts[2] || null, episode: parts[3] || null };
}

/** Ordem de inspeção — não decide a escolha final, só quem é sondado primeiro. */
function optionOrderScore(option) {
  const text = String(option.label || "").toLowerCase();
  let score = ehServidorIncorporado(option) ? 100 : 0;
  if (/dublad|portugu|pt-br/.test(text)) score += 40;
  if (/legend|subtitle|leg\b/.test(text)) score -= 10;
  if (/full\s*hd|1080|hd/.test(text)) score += 5;
  return score;
}

/**
 * Pede a lista de servidores ao protocolo atual. Antes essa lista era raspada do
 * HTML de uma página Vizero/WarezCDN que saiu da cadeia; agora vem em JSON, já
 * com o nome e o tipo de cada servidor.
 */
async function fetchBootstrap(fetchImpl, jar, page, pageToken, contentId, contentPath, ua) {
  const origin = new URL(page.url).origin;
  const { tipo, season, episode } = contentCoordinates(contentPath);

  const form = new URLSearchParams();
  form.set("contentid", contentId);
  form.set("type", tipo);
  if (season) form.set("season", season);
  if (episode) form.set("episode", episode);
  form.set("_token", "");
  form.set("page_token", pageToken);
  // O provedor envia o token nas duas grafias; manter as duas evita depender de
  // qual delas o backend lê.
  form.set("pageToken", pageToken);

  const response = await requestOnce(fetchImpl, jar, `${origin}/player/bootstrap`, {
    ua,
    method: "POST",
    referer: page.url,
    dest: "empty",
    mode: "cors",
    accept: "*/*",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: origin,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: form.toString(),
  });

  const text = await response.text();
  if (!response.ok) throw httpError("player/bootstrap", response, response.url || `${origin}/player/bootstrap`, text);
  if (isCloudflareChallenge(text)) {
    throw new SuperflixAuthorizationError("player/bootstrap requer nova autorização", { status: response.status, stage: "player/bootstrap" });
  }
  const json = JSON.parse(text);
  const options = json?.data?.options;
  if (!Array.isArray(options)) throw new Error("player/bootstrap sem options");

  const parsed = [];
  for (const option of options) {
    // ID vem como número nos servidores incorporados e como string nos nativos.
    const id = option?.ID === undefined || option.ID === null ? "" : String(option.ID).trim();
    if (!id) continue;
    const item = {
      id,
      label: option.name || `Servidor ${id}`,
      isFile: Boolean(option.is_file),
    };
    item.orderScore = optionOrderScore(item);
    parsed.push(item);
  }
  return parsed;
}

/**
 * Lista de servidores pelo protocolo atual, caindo para a varredura de HTML
 * quando o `contentid` não está na página ou o bootstrap não responde.
 */
async function resolveOptions(fetchImpl, jar, page, pageToken, payload, ua) {
  const contentId = findContentId(page.html);
  if (contentId) {
    const contentPath = payload?.embed_content_path || new URL(page.url).pathname;
    const bootstrap = await fetchBootstrap(fetchImpl, jar, page, pageToken, contentId, contentPath, ua)
      .catch((error) => {
        if (isAuthorizationError(error)) throw error;
        slog("bootstrap_skip", String(error?.message || error).slice(0, 120));
        return [];
      });
    if (bootstrap.length) {
      slog("bootstrap", `servidores=${bootstrap.length} arquivos=${bootstrap.filter((o) => o.isFile).length}`);
      return bootstrap.sort((a, b) => b.orderScore - a.orderScore);
    }
  } else {
    slog("bootstrap_skip", "contentid não encontrado na página");
  }

  // Protocolo legado: os IDs vinham no HTML e o rótulo era o texto ao redor.
  return findSourceIds(page.html).map((id, index) => ({
    id,
    label: id,
    isFile: null,
    orderScore: -index,
  }));
}

function findNativeMediaSource(html, baseUrl) {
  const normalized = normalizeHtml(html);
  const arrayMatch = normalized.match(/var\s+SOURCES\s*=\s*(\[[\s\S]*?\])\s*;/i);
  if (arrayMatch) {
    try {
      const sources = JSON.parse(arrayMatch[1]);
      for (const source of sources) {
        const resolved = resolveUrl(source?.src, baseUrl);
        if (resolved && isServerProvidedNativeRoute(resolved, "nms")) return resolved;
      }
    } catch { /**/ }
  }

  const matches = normalized.matchAll(/["'](https?:\/\/[^"']+)["']/gi);
  for (const match of matches) {
    const resolved = resolveUrl(match[1], baseUrl);
    if (resolved && isServerProvidedNativeRoute(resolved, "nms")) return resolved;
  }
  return null;
}

function isServerProvidedNativeRoute(raw, expected = null) {
  try {
    const parsed = new URL(raw);
    const route = `${parsed.pathname}${parsed.search}`;
    if (expected === "nms") {
      return parsed.pathname.includes("/player/native/media-source") || /(?:^|[/=?&])nms_[A-Za-z0-9_-]+/i.test(route);
    }
    return parsed.pathname.includes("/player/native/media/") ||
      /(?:^|[/=?&])nmp_[A-Za-z0-9_-]+/i.test(route);
  } catch {
    return false;
  }
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

  const domainMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

  function parseCookie(raw, responseUrl) {
    const parsedUrl = new URL(responseUrl);
    const parts = String(raw).split(";").map((part) => part.trim());
    const first = parts.shift();
    if (!first?.includes("=")) return null;
    const separator = first.indexOf("=");
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1);
    if (!name) return null;

    const cookie = {
      name,
      value,
      domain: parsedUrl.hostname.toLowerCase(),
      hostOnly: true,
      path: parsedUrl.pathname.includes("/")
        ? parsedUrl.pathname.slice(0, parsedUrl.pathname.lastIndexOf("/") + 1) || "/"
        : "/",
      secure: parsedUrl.protocol === "https:",
      httpOnly: false,
      sameSite: "unspecified",
      expiresAt: null,
      sourceUrl: responseUrl,
    };

    for (const attr of parts) {
      const attrSeparator = attr.indexOf("=");
      const key = (attrSeparator >= 0 ? attr.slice(0, attrSeparator) : attr).trim().toLowerCase();
      const valuePart = attrSeparator >= 0 ? attr.slice(attrSeparator + 1).trim() : "";
      if (key === "domain" && valuePart) {
        const domain = valuePart.replace(/^\./, "").toLowerCase();
        if (!domainMatches(parsedUrl.hostname.toLowerCase(), domain)) return null;
        cookie.domain = domain;
        cookie.hostOnly = false;
      } else if (key === "path" && valuePart.startsWith("/")) cookie.path = valuePart;
      else if (key === "secure") cookie.secure = true;
      else if (key === "httponly") cookie.httpOnly = true;
      else if (key === "samesite") {
        const sameSite = valuePart.toLowerCase();
        cookie.sameSite = sameSite === "lax" || sameSite === "strict" || sameSite === "none"
          ? sameSite : "unspecified";
      } else if (key === "max-age") {
        const seconds = Number(valuePart);
        if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
      } else if (key === "expires" && cookie.expiresAt == null) {
        const expires = Date.parse(valuePart);
        if (Number.isFinite(expires)) cookie.expiresAt = expires;
      }
    }
    return cookie;
  }

  async function absorb(url, headers) {
    let values = [];
    if (typeof headers.getSetCookie === "function") values = headers.getSetCookie();
    if (!values.length) {
      const combined = headers.get("set-cookie");
      if (combined) {
        // Separa múltiplos Set-Cookie sem quebrar a vírgula do atributo Expires.
        values = combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
      }
    }

    let updated = false;
    for (const raw of values) {
      const cookie = parseCookie(raw, url);
      if (!cookie) continue;
      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      if (cookie.expiresAt != null && cookie.expiresAt <= Date.now()) {
        updated = cookies.delete(key) || updated;
      } else {
        cookies.set(key, cookie);
        updated = true;
      }
      if (typeof absorb.onCookie === "function") await absorb.onCookie(cookie);
    }
    return updated;
  }

  function header(url) {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname.toLowerCase();
    const path = parsedUrl.pathname || "/";
    const secure = parsedUrl.protocol === "https:";
    const now = Date.now();
    return [...cookies.values()]
      .filter((cookie) => (cookie.expiresAt == null || cookie.expiresAt > now) &&
        domainMatches(host, cookie.domain) && path.startsWith(cookie.path || "/") &&
        (!cookie.secure || secure))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  /** Importa somente cookies obtidos legitimamente pelo navegador. */
  function seed(rawCookies, fallbackUrl) {
    if (!rawCookies) return;
    const fallbackHost = new URL(fallbackUrl).hostname.toLowerCase();
    const items = Array.isArray(rawCookies)
      ? rawCookies
      : String(rawCookies).split(";").map((part) => {
          const separator = part.indexOf("=");
          if (separator <= 0) return null;
          return {
            name: part.slice(0, separator).trim(),
            value: part.slice(separator + 1).trim(),
            domain: fallbackHost,
          };
        }).filter(Boolean);

    for (const item of items) {
      const name = String(item?.name || "").trim();
      if (!name) continue;
      const domain = String(item?.domain || fallbackHost).replace(/^\./, "").toLowerCase();
      const path = String(item?.path || "/");
      cookies.set(`${domain}|${path}|${name}`, {
        domain,
        name,
        value: String(item?.value || ""),
        hostOnly: !String(item?.domain || "").startsWith("."),
        path,
        secure: Boolean(item?.secure),
        httpOnly: Boolean(item?.httpOnly),
        sameSite: String(item?.sameSite || "unspecified").toLowerCase(),
        expiresAt: Number.isFinite(Number(item?.expirationDate)) ? Number(item.expirationDate) * 1000 : null,
        sourceUrl: fallbackUrl,
      });
    }
  }

  absorb.onCookie = null;
  return {
    absorb,
    header,
    seed,
    setCookieSink(callback) { absorb.onCookie = callback; },
    snapshot() { return [...cookies.values()].map((cookie) => ({ ...cookie })); },
  };
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
  const cookieJarUpdated = await jar.absorb(url, response.headers);
  if (options.trace?.record) options.trace.record(url, response.status, cookieJarUpdated);
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
      // O provedor redireciona para HTTP em parte da cadeia. No Android isso morre
      // por politica de cleartext antes de chegar a midia; aqui a promocao mantem
      // os dois extratores com o mesmo comportamento.
      const resolvido = resolveUrl(location, url);
      const next = resolvido ? secureTransportUrl(resolvido) : null;
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
    if (isServerProvidedNativeRoute(url) && hasExpiredNativeOption(text)) {
      throw new SuperflixNativeOptionExpiredError("native-media");
    }
    if (!response.ok) throw httpError("navegação", response, url, text);
    if (isCloudflareChallenge(text)) {
      throw new SuperflixAuthorizationError("challenge Superflix detectado", { status: response.status, stage: "page" });
    }
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

    // Protocolo atual: a própria página do SuperFlix traz page_token e contentid,
    // e a lista de servidores vem de /player/bootstrap. Seguir links daqui só
    // levava a becos, já que Vizero/WarezCDN saíram da cadeia.
    if (findPageToken(page.text) && findContentId(page.text)) {
      return { url: finalUrl, html: page.text };
    }

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

async function postSource(fetchImpl, jar, warezPage, pageToken, sourceId, host, ua, trace = null) {
  const origin = new URL(warezPage.url).origin;
  // Sem Vizero/WarezCDN na cadeia, host e site vão vazios e o endpoint perde a
  // query. Mandar "vizero.buzz" (o antigo padrão) descrevia um salto que não
  // acontece mais.
  const endpoint = host
    ? `${origin}/player/source?host=${encodeURIComponent(host)}`
    : `${origin}/player/source`;
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
    trace,
  });
  const text = await response.text();
  if (!response.ok) throw httpError("player/source", response, endpoint, text);
  if (isCloudflareChallenge(text)) {
    throw new SuperflixAuthorizationError("player/source requer nova autorização", { status: response.status, stage: "player/source" });
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("player/source retornou JSON inválido"); }
  const videoUrl = json?.data?.video_url || json?.video_url;
  if (!videoUrl) throw new Error("video_url ausente em player/source");
  return resolveUrl(videoUrl, endpoint);
}

async function resolveSource(fetchImpl, jar, targetUrl, warezPageUrl, host, ua, extractEmbedPlayer, trace = null) {
  const first = await requestOnce(fetchImpl, jar, targetUrl, {
    ua,
    referer: warezPageUrl,
    readBody: false,
    trace,
  });

  let resolvedUrl = targetUrl;
  let firstNativePage = null;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    // Mesmo motivo do fetchPage: o destino do player/redirect pode vir em HTTP.
    const resolvido = resolveUrl(location, targetUrl);
    resolvedUrl = resolvido ? secureTransportUrl(resolvido) : null;
    if (!resolvedUrl) throw new Error("player/redirect sem Location válido");
  } else if (isServerProvidedNativeRoute(targetUrl)) {
    const text = await first.text();
    if (hasExpiredNativeOption(text)) {
      throw new SuperflixNativeOptionExpiredError("native-media");
    }
    if (!first.ok) throw httpError("native-media", first, targetUrl, text);
    firstNativePage = { url: targetUrl, response: first, text };
  } else if (!first.ok) {
    throw httpError("player/redirect", first, targetUrl);
  }

  const parsed = new URL(resolvedUrl);
  slog("target", safeUrlLabel(resolvedUrl));

  if (isServerProvidedNativeRoute(resolvedUrl)) {
    const mediaPage = firstNativePage || await fetchPage(fetchImpl, jar, resolvedUrl, {
        ua,
        referer: warezPageUrl,
        trace,
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
      trace,
    });

    if (mediaResponse.status >= 300 && mediaResponse.status < 400) {
      const redirected = resolveUrl(mediaResponse.headers.get("location"), mediaSource);
      const finalUrl = redirected ? secureTransportUrl(redirected) : null;
      if (!finalUrl) throw new Error("media-source sem Location final em HTTPS");
      return { stream: finalUrl, referer: null, tipo: looksLikeHlsUrl(finalUrl) ? "hls" : "mp4", subtitles };
    }

    const contentType = mediaResponse.headers.get("content-type") || "";
    const contentLength = Number(mediaResponse.headers.get("content-length"));
    const shouldInspectBody = !mediaResponse.ok ||
      /text|json|xml|html/i.test(contentType) ||
      (Number.isFinite(contentLength) && contentLength >= 0 && contentLength <= 1024);
    const mediaBody = shouldInspectBody ? await mediaResponse.text() : "";
    if (hasExpiredNativeOption(mediaBody)) {
      throw new SuperflixNativeOptionExpiredError("native-media-source");
    }
    if (mediaResponse.ok && /video\/mp4|octet-stream/i.test(contentType)) {
      return { stream: mediaSource, referer: mediaPage.url, tipo: "mp4", subtitles };
    }
    throw httpError("media-source", mediaResponse, mediaSource, mediaBody);
  }

  if (
    parsed.hostname.includes("embedplayer") ||
    PUNYCODE_EMBEDPLAYER.test(parsed.hostname) ||
    /\/video\/[a-f0-9]{16,}/i.test(parsed.pathname)
  ) {
    if (typeof extractEmbedPlayer !== "function") throw new Error("extrator embedplayer indisponível");
    // Legendas ficam no HTML do embed; sem elas o player abre só com o áudio.
    const subtitles = await fetchPage(fetchImpl, jar, resolvedUrl, { ua, referer: warezPageUrl, trace })
      .then((page) => findSubtitleTracks(page.text, page.url))
      .catch(() => []);
    // Uma recusa do player externo pertence a esta fonte, não à autorização
    // Superflix. Ela deve cair no failover normal sem reabrir o challenge.
    const raw = await extractEmbedPlayer(
      resolvedUrl,
      `${new URL(warezPageUrl).origin}/`,
      ua,
      jar.header(resolvedUrl),
      trace,
    );
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

  const fallbackPage = await fetchPage(fetchImpl, jar, resolvedUrl, { ua, referer: warezPageUrl, trace });
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
function profileScore(tipo, info, hasSubtitles, option) {
  let score;
  if (info?.isMaster) score = 70 + Math.min(info.variants.length, 5) * 6;
  else if (tipo === "hls") score = 45;
  else score = 20;

  if ((info?.audioTracks?.length || 0) >= 2) score += 35;
  if (hasSubtitles) score += 25;
  // Desempate: historicamente o servidor alternativo é o mais estável.
  if (ehServidorIncorporado(option)) score += 3;
  return score;
}

/**
 * Descobre o que a fonte entrega sem baixar mídia à toa: quando a URL não denuncia
 * o formato, um Range de 1 byte revela o Content-Type; o corpo só é lido quando o
 * alvo é mesmo um manifesto.
 */
async function profileSource(fetchImpl, jar, option, candidate, ua, timeoutMs = DEFAULT_TIMEOUT_MS, trace = null) {
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
      timeoutMs,
      trace,
    }).catch(() => null);
    if (!head || !head.ok) {
      if (head && isAuthorizationStatus(head.status)) throw httpError("mídia", head, url);
      throw new Error(`mídia inacessível${head ? ` (HTTP ${head.status})` : ""}`);
    }
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
      timeoutMs,
      trace,
    }).catch(() => null);
    if (!manifest || !manifest.ok) {
      if (manifest && isAuthorizationStatus(manifest.status)) throw httpError("manifesto", manifest, url);
      throw new Error(`manifesto inacessível${manifest ? ` (HTTP ${manifest.status})` : ""}`);
    }
    const body = await manifest.text().catch(() => "");
    if (!hlsManifest.looksLikeManifest(body)) throw new Error("resposta não é manifesto HLS");
    info = hlsManifest.parse(body, url);
  } else if (tipo === "mp4") {
    const media = await requestOnce(fetchImpl, jar, url, {
      ua,
      referer: candidate.referer,
      accept: "*/*",
      dest: "video",
      mode: "no-cors",
      headers: { Range: "bytes=0-0" },
      readBody: false,
      timeoutMs,
      trace,
    }).catch(() => null);
    if (!media || !media.ok) {
      if (media && isAuthorizationStatus(media.status)) throw httpError("MP4", media, url);
      throw new Error(`MP4 inacessível${media ? ` (HTTP ${media.status})` : ""}`);
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
  const score = profileScore(tipo, info, hasSubtitles, option);
  slog(
    "profile",
    `is_file=${Boolean(option.isFile)} tipo=${tipo} master=${Boolean(info?.isMaster)} ` +
      `qualidades=${info?.variants.length || 0} audios=${info?.audioTracks.length || 0} ` +
      `legendas=${subtitles.size} noManifesto=${info?.subtitles.length || 0} nota=${score}`,
  );

  return {
    option,
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

function publicOptionLabel(option, index) {
  const original = String(option.label || "").replace(/\s+/g, " ").trim();
  const text = original.toLowerCase();
  const safeCharacters = /^[\p{L}\p{N} ._+()/-]{1,48}$/u.test(original);
  const containsSensitiveShape = /https?:|www\.|\.[a-z]{2,}(?:\b|\/)|[?&=]|(?:token|cookie|clearance|cfv|signature|video[_-]?id)/i
    .test(original);
  // A projeção pública não pode revelar um provedor/host real. Preservamos
  // nomes descritivos do próprio bootstrap apenas quando compostos por termos
  // visuais genéricos; o valor original continua disponível somente na sessão.
  const usefulGenericName = /^(?=.*(?:servidor|player|fonte|canais?|op[cç][aã]o|principal|alternativ|mp4|hls|hd|full hd|dublad|legendad|portugu[eê]s|original))[\p{L}\p{N} ._+()/-]+$/iu
    .test(original);
  if (safeCharacters && !containsSensitiveShape && usefulGenericName) return original;

  const suffix = /dublad|portugu|pt-br/.test(text)
    ? " · Dublado"
    : /legend|subtitle|\bleg\b/.test(text)
      ? " · Legendado"
      : "";
  return `Servidor ${index + 1}${suffix}`;
}

/**
 * Estado efêmero de uma página Superflix já autorizada.
 *
 * PAGE_TOKEN, cfv, cookies e IDs reais nunca saem desta instância. O renderer
 * recebe somente chaves aleatórias e rótulos públicos; ao escolher uma opção,
 * a URL final é resolvida naquele momento para não envelhecer em cache.
 */
class SuperflixSession {
  constructor(state) {
    Object.assign(this, state);
    this.optionByKey = new Map();
    this.publicOptions = state.sourceOptions.map((option, index) => {
      const key = randomUUID();
      this.optionByKey.set(key, option);
      return {
        key,
        label: publicOptionLabel(option, index),
        isFile: Boolean(option.isFile),
      };
    });
  }

  static async prepare(embedUrl, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("fetch indisponível no Electron");

    const ua = options.ua || DEFAULT_UA;
    const appReferer = options.appReferer || "https://obaflix.vercel.app/";
    const input = new URL(embedUrl);
    if (!EH_SUPERFLIX.test(input.hostname)) throw new Error("URL SuperFlix inválida");

    const jar = options.jar || createCookieJar();
    if (options.onSetCookie) jar.setCookieSink(options.onSetCookie);
    jar.seed(options.cookies, embedUrl);
    const startUrl = options.authorizedUrl || embedUrl;
    const warezPage = await resolveWarezPage(fetchImpl, jar, startUrl, ua, appReferer);
    const pageToken = findPageToken(warezPage.html);
    if (!pageToken) throw new Error("page_token não encontrado na página autorizada");

    const tokenPayload = decodeTokenPayload(pageToken) || {};
    const host = tokenPayload.embed_context_host || new URL(warezPage.url).searchParams.get("host") || "";
    const sourceOptions = await resolveOptions(fetchImpl, jar, warezPage, pageToken, tokenPayload, ua);
    if (!sourceOptions.length) throw new Error("nenhum servidor encontrado para o conteúdo");

    const session = new SuperflixSession({
      embedUrl,
      fetchImpl,
      ua,
      jar,
      warezPage,
      pageToken,
      host,
      sourceOptions,
      expiresAt: tokenExpiry(tokenPayload),
      extractEmbedPlayer: options.extractEmbedPlayer,
    });
    slog("session_ready", `superflix_bootstrap_ok options=${sourceOptions.length}`);
    return session;
  }

  assertFresh() {
    if (this.expiresAt && Date.now() >= this.expiresAt - 5_000) {
      throw new SuperflixAuthorizationError("sessão Superflix expirada", { stage: "page_token" });
    }
  }

  async revalidate() {
    this.assertFresh();
    const page = await fetchPage(this.fetchImpl, this.jar, this.warezPage.url, {
      ua: this.ua,
      referer: this.warezPage.url,
    });
    const currentToken = findPageToken(page.text);
    if (!currentToken) return false;
    const payload = decodeTokenPayload(currentToken);
    const expiry = tokenExpiry(payload);
    if (expiry && Date.now() >= expiry - 5_000) return false;
    // Token novo implica bootstrap novo; o gerenciador fará uma preparação
    // autenticada e substituirá este contexto sem mostrar challenge.
    return currentToken === this.pageToken;
  }

  context() {
    return {
      ua: this.ua,
      authorizedUrl: this.warezPage.url,
      jar: this.jar,
    };
  }

  optionIdentity(optionKey) {
    const option = this.optionByKey.get(optionKey);
    return option ? { id: option.id, label: option.label, isFile: option.isFile } : null;
  }

  findOptionKey(identity) {
    if (!identity) return null;
    let fallback = null;
    for (const [key, option] of this.optionByKey.entries()) {
      if (option.id === identity.id) return key;
      if (!fallback && option.label === identity.label && option.isFile === identity.isFile) fallback = key;
    }
    return fallback;
  }

  describe() {
    this.assertFresh();
    return { options: this.publicOptions, expiresAt: this.expiresAt };
  }

  async resolve(optionKey, { trace = null } = {}) {
    this.assertFresh();
    const option = this.optionByKey.get(optionKey);
    if (!option) throw new Error("servidor Superflix inválido");
    slog("source_selected", `is_file=${Boolean(option.isFile)}`);

    const targetUrl = await postSource(
      this.fetchImpl, this.jar, this.warezPage, this.pageToken, option.id, this.host, this.ua, trace,
    );
    const candidate = await resolveSource(
      this.fetchImpl,
      this.jar,
      targetUrl,
      this.warezPage.url,
      this.host,
      this.ua,
      this.extractEmbedPlayer,
      trace,
    );
    const profile = await profileSource(
      this.fetchImpl, this.jar, option, candidate, this.ua, PROBE_TIMEOUT_MS, trace,
    );
    slog("source_ok", `superflix_source_ok is_file=${Boolean(option.isFile)} tipo=${profile.result.tipo}`);
    const publicOption = this.publicOptions.find((item) => item.key === optionKey);
    return {
      ...profile.result,
      expiresAt: this.expiresAt,
      effectiveOptionKey: optionKey,
      effectiveOptionLabel: publicOption?.label || "Servidor",
      effectiveOptionIsFile: Boolean(publicOption?.isFile),
    };
  }

  async resolveWithFailover(preferredKey = null, { bubbleNativeExpiry = false, trace = null } = {}) {
    this.assertFresh();
    const keys = this.publicOptions.map((option) => option.key);
    if (preferredKey && keys.includes(preferredKey)) {
      keys.splice(keys.indexOf(preferredKey), 1);
      keys.unshift(preferredKey);
    }

    const failures = [];
    for (let index = 0; index < keys.length; index += 1) {
      try {
        return await this.resolve(keys[index], { trace });
      } catch (error) {
        if (isAuthorizationError(error) || (bubbleNativeExpiry && isNativeOptionExpiredError(error))) throw error;
        const message = error?.message || String(error);
        failures.push(message);
        slog("candidate_rejected", `superflix_candidate_rejected index=${index + 1} erro=${message.slice(0, 100)}`);
        if (index + 1 < keys.length) slog("failover", `superflix_failover next=${index + 2}`);
      }
    }
    throw new Error(`todas as fontes Superflix falharam: ${failures.join(" | ").slice(0, 500)}`);
  }
}

async function prepareSuperflixSession(embedUrl, options = {}) {
  return SuperflixSession.prepare(embedUrl, options);
}

async function retryAuthorizationOnce(operation, renew) {
  try {
    return await operation();
  } catch (error) {
    if (!isAuthorizationError(error)) throw error;
    await renew(error);
    // Deliberadamente sem nova captura: uma segunda falha de autorização
    // encerra o ciclo em vez de abrir outro challenge.
    return await operation();
  }
}

async function retryNativeOptionOnce(operation, renew, retryOperation = operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isNativeOptionExpiredError(error)) throw error;
    await renew(error);
    // Sem nova captura: uma segunda expiração nunca inicia outra reconstrução.
    return await retryOperation();
  }
}

async function extractSuperflix(embedUrl, options = {}) {
  const session = await prepareSuperflixSession(embedUrl, options);
  return session.resolveWithFailover(options.preferredOptionKey || null);
}

module.exports = {
  extractSuperflix,
  prepareSuperflixSession,
  SuperflixSession,
  SuperflixAuthorizationError,
  SuperflixNativeOptionExpiredError,
  createResolutionAttemptTrace,
  isAuthorizationError,
  isNativeOptionExpiredError,
  shareInFlightResolution,
  retryAuthorizationOnce,
  retryNativeOptionOnce,
  // Exportado apenas para testes locais do parser; não é usado pelo app.
  _test: {
    normalizeHtml,
    collectChainUrls,
    findPageToken,
    findSourceIds,
    findNativeMediaSource,
    isServerProvidedNativeRoute,
    findDirectMedia,
    findSubtitleTracks,
    findContentId,
    contentCoordinates,
    fetchBootstrap,
    createCookieJar,
    optionOrderScore,
    ehServidorIncorporado,
    decodeTokenPayload,
    secureTransportUrl,
    profileScore,
    tokenExpiry,
    publicOptionLabel,
    createResolutionAttemptTrace,
    isAuthorizationError,
    isNativeOptionExpiredError,
    shareInFlightResolution,
    retryAuthorizationOnce,
    retryNativeOptionOnce,
    looksLikeHlsUrl,
    looksLikeMp4Url,
  },
};
