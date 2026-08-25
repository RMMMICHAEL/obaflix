"use strict";

// Extrator nativo do SuperFlixAPI.
// Toda a cadeia roda no dispositivo do usuário (Electron), sem Vercel:
// SuperFlix -> Vizero -> WarezCDN -> player/source -> MP4/HLS final.

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";

// O provedor migrou de superflixapi.pro para superflixapi.sbs; o antigo ainda
// responde 301 e aparece em URLs gravadas, entao os dois seguem aceitos.
const EH_SUPERFLIX = /(^|.)superflixapi.(pro|sbs)$/i;

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

// O extrator também roda fora do Electron (scripts de diagnóstico), então o logger
// é opcional: sem ele, cai no console como antes.
let log = null;
try { log = require("./logger"); } catch { /* fora do app */ }

function slog(step, detail = "") {
  if (log) log.debug(`superflix.${step}`, detail || "-");
  else console.log(`[superflix/${step}]${detail ? ` ${detail}` : ""}`);
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
  if (!response.ok) throw new Error(`player/bootstrap HTTP ${response.status}`);
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
        slog("bootstrap_skip", String(error?.message || error).slice(0, 120));
        return [];
      });
    if (bootstrap.length) {
      slog("bootstrap", "servidores=" + bootstrap.map((o) => o.label).join(", "));
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

async function postSource(fetchImpl, jar, warezPage, pageToken, sourceId, host, ua) {
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
    // Mesmo motivo do fetchPage: o destino do player/redirect pode vir em HTTP.
    const resolvido = resolveUrl(location, targetUrl);
    resolvedUrl = resolvido ? secureTransportUrl(resolvido) : null;
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
async function profileSource(fetchImpl, jar, option, candidate, ua, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
      timeoutMs,
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
  const score = profileScore(tipo, info, hasSubtitles, option);
  slog(
    "profile",
    `source=${option.label} tipo=${tipo} master=${Boolean(info?.isMaster)} ` +
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

async function extractSuperflix(embedUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch indisponível no Electron");

  const ua = options.ua || DEFAULT_UA;
  const appReferer = options.appReferer || "https://obaflix.vercel.app/";
  const jar = createCookieJar();

  const input = new URL(embedUrl);
  if (!EH_SUPERFLIX.test(input.hostname)) {
    throw new Error("URL SuperFlix inválida");
  }

  const warezPage = await resolveWarezPage(fetchImpl, jar, embedUrl, ua, appReferer);
  const pageToken = findPageToken(warezPage.html);
  if (!pageToken) throw new Error("page_token não encontrado na página WarezCDN");

  const tokenPayload = decodeTokenPayload(pageToken) || {};
  const host = tokenPayload.embed_context_host || new URL(warezPage.url).searchParams.get("host") || "";
  const sourceOptions = await resolveOptions(fetchImpl, jar, warezPage, pageToken, tokenPayload, ua);
  if (!sourceOptions.length) throw new Error("nenhum servidor encontrado para o conteúdo");

  slog(
    "sources",
    `total=${sourceOptions.length} nativos=${sourceOptions.filter((o) => !ehServidorIncorporado(o)).length}`,
  );

  const failures = [];
  const profiles = [];
  const expiresAt = tokenExpiry(tokenPayload);
  const probeDeadline = Date.now() + PROBE_BUDGET_MS;

  // Inspeciona os servidores em vez de aceitar o primeiro que responde: o primeiro
  // funcional costuma ser um MP4 de qualidade única, enquanto outro servidor entrega
  // um master HLS com qualidades, áudio e legendas.
  let probed = 0;
  for (const sourceOption of sourceOptions) {
    // O corte é avaliado ANTES de gastar mais uma rodada. Antes ele só rodava no
    // fim da iteração e apenas quando já havia alguma fonte boa, então uma fila de
    // servidores mortos ignorava o orçamento inteiro e estourava o tempo de espera.
    if (probed > 0 && Date.now() > probeDeadline) {
      slog("probe_stop", `orçamento de ${PROBE_BUDGET_MS}ms esgotado após ${probed} servidor(es), ${profiles.length} aproveitável(is)`);
      break;
    }
    if (probed >= MAX_PROBED_SOURCES) {
      slog("probe_stop", `limite de ${MAX_PROBED_SOURCES} servidores inspecionados atingido`);
      break;
    }

    probed += 1;
    const sourceStart = Date.now();
    let mark = sourceStart;
    const lap = (name) => { const d = Date.now() - mark; mark = Date.now(); return `${name}:${d}ms`; };
    const laps = [];

    try {
      const targetUrl = await postSource(fetchImpl, jar, warezPage, pageToken, sourceOption.id, host, ua);
      laps.push(lap("post_source"));
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
      laps.push(lap("resolve_source"));
      const profile = await profileSource(fetchImpl, jar, sourceOption, candidate, ua, PROBE_TIMEOUT_MS);
      laps.push(lap("profile"));
      profiles.push(profile);
      slog("source_ok", `source=${sourceOption.label} nota=${profile.score} total=${Date.now() - sourceStart}ms ${laps.join(" ")}`);

      if (profile.score >= EXCELLENT_SCORE) {
        slog("probe_stop", `fonte completa encontrada em ${sourceOption.label}`);
        break;
      }
      // Já dá para começar a tocar: parar aqui vale mais que achar algo 5% melhor.
      if (profile.score >= GOOD_ENOUGH_SCORE) {
        slog("probe_stop", `fonte boa o bastante em ${sourceOption.label} (nota=${profile.score})`);
        break;
      }
    } catch (error) {
      const message = error?.message || String(error);
      failures.push(`${sourceOption.label}: ${message}`);
      slog("source_skip", `source=${sourceOption.label} total=${Date.now() - sourceStart}ms ${laps.join(" ")} erro=${message.slice(0, 100)}`);
    }
  }
  slog("probe_resumo", `inspecionados=${probed}/${sourceOptions.length} aproveitaveis=${profiles.length} falhas=${failures.length}`);

  if (!profiles.length) {
    throw new Error(`todas as fontes SuperFlix falharam: ${failures.join(" | ").slice(0, 500)}`);
  }

  const best = profiles.reduce((a, b) => (b.score > a.score ? b : a));
  slog(
    "ok",
    `escolhida=${best.option.label} nota=${best.score} entre=${profiles.length} ` +
      `tipo=${best.result.tipo} host=${safeUrlLabel(best.result.stream)}`,
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
    looksLikeHlsUrl,
    looksLikeMp4Url,
  },
};
