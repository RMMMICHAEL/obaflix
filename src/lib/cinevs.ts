// ─────────────────────────────────────────────────────────────────────────────
// extractCineVs — extrator ISOLADO e DESATIVADO por padrão.
//
// Reproduz APENAS o fluxo comprovado no bytecode do app `tv16.apk`
// (package com.cnvs.apptv, base `/api/v1/`):
//
//     refresh → /videos → /video/{videoId} → resolve-url → URL final
//
// Atualizado em 26/08/2026 a partir dos HARs do site (fluxo web real):
//   • o passo `resolve-url` EXISTE e é obrigatório — `video_url` é payload
//     cifrado, não URL. Exige payload E session_id.
//   • base migrou de `webcinevs2.com/api` para `utxptx-api.b-cdn.net/api/v1`.
//   • a API exige Origin/Referer do site; a MÍDIA não exige nada (medido).
//   • NÃO envia/forja X-App-Sig, X-App-Integrity nem X-Ad-Proof.
//   • video_url vem direto de /video/{videoId} (o cliente nativo não a transforma).
//
// Estado de cada parte:
//   [BYTECODE]  comprovado na engenharia reversa estática do APK.
//   [RUNTIME]   só validável executando com uma conta/host reais do usuário.
//
// Regras de segurança respeitadas neste arquivo:
//   • host, credenciais e ativação vêm de variáveis de ambiente.
//   • refresh_token, JWT e URL completa NUNCA são registrados nem embutidos.
//   • nenhum atestado de assinatura de app é forjado.
//   • nada é servido por proxy público a partir daqui.
// ─────────────────────────────────────────────────────────────────────────────

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// ── Configuração via env ─────────────────────────────────────────────────────
export interface CineVsConfig {
  /** Base completa da API, ex.: https://SEU-HOST/api/v1  (sem barra final) */
  base: string;
  refreshToken: string;
  deviceId: string;
  profileId: string;
  /** Caminho do refresh, relativo à base. [RUNTIME] confirme o correto p/ sua conta. */
  authPath: string;
  /** Valores de query device_type/platform. [RUNTIME] ajuste conforme o servidor aceitar. */
  platform: string;
  deviceType: string;
  /** Header X-Client-Platform opcional. Vazio = não enviado (evita casar com atestado). */
  clientPlatform: string;
  enabled: boolean;
}

class CineVsConfigError extends Error {}

/**
 * Lê a configuração do ambiente. Lança erro claro (sem vazar valores) se faltar algo.
 * `requireCreds` = true exige host + refresh_token (usado pelo modo diagnóstico/execução).
 */
/**
 * Base confirmada em 26/08/2026 pelos HARs do webcinevs2.com. A base antiga
 * (`webcinevs2.com/api`) nao responde mais; o emissor dos tokens e um terceiro
 * host, `urobotsy.com`, que so aparece dentro do JWT.
 */
const BASE_PADRAO = "https://utxptx-api.b-cdn.net/api/v1";

/** Aceita as duas familias de variaveis: o repo ja usava WEBCINE_* antes. */
const env = (...nomes: string[]): string => {
  for (const n of nomes) {
    const v = process.env[n];
    if (v) return v;
  }
  return "";
};

export function cineVsConfig(requireCreds = true): CineVsConfig {
  const base = (env("CINEVS_API_BASE", "WEBCINE_API_BASE") || BASE_PADRAO).replace(/\/+$/, "");
  const refreshToken = env("CINEVS_REFRESH_TOKEN", "WEBCINE_REFRESH_TOKEN");
  const missing: string[] = [];
  if (requireCreds && !refreshToken) missing.push("CINEVS_REFRESH_TOKEN");
  if (missing.length) {
    throw new CineVsConfigError(
      `Variáveis ausentes: ${missing.join(", ")}. Veja docs/cinevs-diagnostico.md.`,
    );
  }
  return {
    base,
    refreshToken,
    deviceId: env("CINEVS_DEVICE_ID", "WEBCINE_DEVICE_ID"),
    profileId: env("CINEVS_PROFILE_ID", "WEBCINE_PROFILE_ID"),
    authPath: (process.env.CINEVS_AUTH_PATH ?? "auth/refresh").replace(/^\/+/, ""),
    platform: process.env.CINEVS_PLATFORM ?? "web",
    deviceType: process.env.CINEVS_DEVICE_TYPE ?? "web",
    clientPlatform: process.env.CINEVS_CLIENT_PLATFORM ?? "",
    enabled: ["1", "true"].includes(env("CINEVS_ENABLED", "WEBCINE_ENABLED").toLowerCase()),
  };
}

export function isCineVsEnabled(): boolean {
  try {
    return cineVsConfig(false).enabled;
  } catch {
    return false;
  }
}

// ── Logs de diagnóstico (sem segredos) ───────────────────────────────────────
// Registra APENAS: status HTTP, endpoint sanitizado (só o path), host da mídia,
// formato identificado e presença (booleana) de parâmetros de expiração.
function log(phase: string, data: Record<string, string | number | boolean | null | undefined>) {
  const parts = Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[cinevs/${phase}] ${parts}`);
}

/** Só o pathname — nunca a query (pode conter device_id/profile_id/token). */
function sanitizePath(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return "?";
  }
}
function mediaHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "?";
  }
}
/** Detecta o formato pela extensão do path (ignora a query), como o ExoPlayer faz. */
function detectFormat(u: string): "HLS" | "DASH" | "MP4" | "MKV" | "SS" | "unknown" {
  const p = sanitizePath(u).toLowerCase();
  if (p.endsWith(".m3u8")) return "HLS";
  if (p.endsWith(".mpd")) return "DASH";
  if (p.endsWith(".mp4") || p.endsWith(".m4v")) return "MP4";
  if (p.endsWith(".mkv")) return "MKV";
  if (p.endsWith(".ism") || p.includes("/manifest")) return "SS";
  return "unknown";
}
/** Presença (booleana) de parâmetros típicos de assinatura/expiração — sem revelá-los. */
function hasExpiryParams(u: string): boolean {
  try {
    const q = new URL(u).searchParams;
    return ["token", "expires", "exp", "e", "st", "md5", "sig", "signature", "hash", "key"].some(
      (k) => q.has(k),
    );
  } catch {
    return false;
  }
}

// ── Rotulagem das fontes ─────────────────────────────────────────────────────

const NOME_AUDIO: Record<string, string> = {
  dubbed: "Dublado",
  dublado: "Dublado",
  subtitled: "Legendado",
  legendado: "Legendado",
  original: "Original",
  dual: "Dual Áudio",
};

function nomeAudio(tipo: string): string {
  const chave = String(tipo || "").toLowerCase();
  return NOME_AUDIO[chave] ?? (chave ? chave[0].toUpperCase() + chave.slice(1) : "Áudio");
}

type VideoBruto = {
  id: number;
  audio_type: string;
  is_premium?: boolean;
  is_code?: boolean;
  locked?: boolean;
  sort_order?: number;
};

/**
 * Converte a lista crua de `/videos` em fontes rotuladas.
 *
 * Numera dentro de cada combinacao audio+premium, entao duas fontes "dubbed"
 * viram "Dublado" e "Dublado 2", e uma premium vira "Dublado Premium".
 * A ordem segue `sort_order`, como o site faz.
 */
export function rotularFontes(
  videos: VideoBruto[],
  acesso: { temAssinatura: boolean; temVip: boolean },
): CineVsFonte[] {
  const ordenados = [...videos].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const contador = new Map<string, number>();

  return ordenados.map((v) => {
    const premium = Boolean(v.is_premium);
    const base = nomeAudio(v.audio_type) + (premium ? " Premium" : "");
    const n = (contador.get(base) ?? 0) + 1;
    contador.set(base, n);

    let motivo: string | undefined;
    if (v.locked) motivo = "bloqueado pelo provedor";
    else if (premium && !acesso.temVip) motivo = "requer VIP";
    else if (v.is_code) motivo = "requer código de desbloqueio";
    else if (!acesso.temAssinatura) motivo = "requer assinatura";

    return {
      videoId: v.id,
      audioType: v.audio_type,
      isPremium: premium,
      isCode: Boolean(v.is_code),
      sortOrder: v.sort_order ?? 0,
      locked: Boolean(v.locked),
      label: n > 1 ? `${base} ${n}` : base,
      disponivel: !motivo,
      ...(motivo ? { motivoIndisponivel: motivo } : {}),
    };
  });
}

/**
 * Confere se a midia pode ir direto ao dispositivo.
 *
 * Só devolve true com prova: uma requisicao real com Origin arbitraria que
 * volte 2xx e com Access-Control-Allow-Origin compativel. Qualquer duvida —
 * erro, ausencia do header, origem diferente — devolve false e a midia volta
 * para o proxy. Fallback fechado de proposito.
 */
async function corsPermiteDireto(url: string, timeoutMs: number): Promise<boolean> {
  const ORIGEM_TESTE = "https://obaflix.vercel.app";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*", Origin: ORIGEM_TESTE },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return false;
    const acao = r.headers.get("access-control-allow-origin");
    return acao === "*" || acao === ORIGEM_TESTE;
  } catch {
    return false;
  }
}

// ── Autenticação (renovação de token) ────────────────────────────────────────
// [BYTECODE] endpoints auth/refresh + auth/token presentes; JWT guardado em "jwt_token".
// [RUNTIME]  o formato exato de corpo/resposta da SUA conta pode variar — ajustável por env.
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(cfg: CineVsConfig, timeoutMs: number): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 300_000) return tokenCache.token;

  const url = `${cfg.base}/${cfg.authPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-device-id": cfg.deviceId,
      "User-Agent": UA,
      "Origin": SITE,
      "Referer": SITE + "/",
    },
    body: JSON.stringify({ refresh_token: cfg.refreshToken }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  log("auth", { path: sanitizePath(url), status: res.status });
  if (!res.ok) throw new Error(`auth HTTP ${res.status} — verifique CINEVS_AUTH_PATH/credenciais`);

  const data = await res.json().catch(() => ({}));
  // Campos vistos no bytecode: "token" e "access_token".
  const token: string | undefined = data.token ?? data.access_token;
  if (!token) throw new Error("auth: resposta sem token (nenhum campo token/access_token)");

  // Decodifica apenas o exp do JWT para cache — nunca loga o token.
  let expiresAt = Date.now() + 60 * 60 * 1000;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (typeof payload.exp === "number") expiresAt = payload.exp * 1000;
  } catch {
    /* token opaco — usa TTL padrão */
  }
  tokenCache = { token, expiresAt };
  log("auth_ok", { cached_until_s: Math.round((expiresAt - Date.now()) / 1000) });
  return token;
}

// Headers autenticados MÍNIMOS e legítimos. Nada de X-App-Sig/Integrity/Ad-Proof.
const SITE = process.env.CINEVS_SITE ?? process.env.WEBCINE_SITE ?? "https://webcinevs2.com";

function authHeaders(cfg: CineVsConfig, token: string): Record<string, string> {
  const h: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "x-device-id": cfg.deviceId,
    "Accept": "application/json",
    "User-Agent": UA,
    // A API roda em outro host e valida a origem do site; sem estes dois o
    // gateway recusa antes de olhar o token.
    "Origin": SITE,
    "Referer": SITE + "/",
  };
  if (cfg.clientPlatform) h["X-Client-Platform"] = cfg.clientPlatform;
  return h;
}

// ── Tipos de resultado ───────────────────────────────────────────────────────
export interface CineVsSubtitle {
  language: string;
  label: string;
  url: string;
}
export interface CineVsResult {
  streamUrl: string;
  /** null quando o CDN nao exige Referer — medido para o webcine. */
  referer: string | null;
  format: ReturnType<typeof detectFormat>;
  mediaHost: string;
  hasExpiry: boolean;
  audioType: string;
  subtitles: CineVsSubtitle[];
  /** Todas as opcoes do conteudo, para o menu de servidor. */
  fontes: CineVsFonte[];
  /** videoId efetivamente usado. */
  videoId: number;
  /**
   * true so quando foi MEDIDO que o CDN aceita origem arbitraria. Sem prova,
   * fica false e a midia volta para o proxy — fallback fechado.
   */
  corsLiberado: boolean;
}

/**
 * Uma das opcoes que `/videos` devolve para o mesmo conteudo. O identificador
 * estavel e o `videoId`: `audioType` se repete (medido — os quatro titulos
 * testados tinham duas fontes "dubbed"), entao rotular por audio colide.
 */
export interface CineVsFonte {
  videoId: number;
  audioType: string;
  isPremium: boolean;
  isCode: boolean;
  sortOrder: number;
  locked: boolean;
  /** Rotulo para o usuario: "Dublado", "Dublado 2", "Dublado Premium". */
  label: string;
  /** false quando exige acesso que a conta nao tem. Nunca contornamos. */
  disponivel: boolean;
  /** Preenchido quando indisponivel, para a UI explicar. */
  motivoIndisponivel?: string;
}

export interface CineVsQuery {
  tmdbId: string;
  type: "movie" | "tv";
  /** Fonte escolhida pelo usuario. Ausente = a primeira disponivel. */
  videoId?: number;
  season?: number;
  episode?: number;
  titleHint?: string;
  /** true = ignora o gate CINEVS_ENABLED (execução local de diagnóstico). */
  diagnostic?: boolean;
}

// ── Pipeline principal ───────────────────────────────────────────────────────
export async function extractCineVs(q: CineVsQuery): Promise<CineVsResult | null> {
  const cfg = cineVsConfig(true);
  if (!cfg.enabled && !q.diagnostic) {
    log("disabled", { note: "CINEVS_ENABLED!=1 e diagnostic=false" });
    return null;
  }

  const TIMEOUT = Number(process.env.CINEVS_TIMEOUT_MS ?? 8000);
  const isMovie = q.type === "movie";
  const season = q.season ?? 1;
  const episode = q.episode ?? 1;
  const t0 = Date.now();

  try {
    const token = await getToken(cfg, TIMEOUT);
    const H = authHeaders(cfg, token);

    // 1. Busca → detalhe → casa tmdb_id.  [BYTECODE] search + movies/{id}/series/{id]
    const searchUrl = `${cfg.base}/search?q=${encodeURIComponent(q.titleHint || q.tmdbId)}`;
    const sRes = await fetch(searchUrl, { headers: H, signal: AbortSignal.timeout(TIMEOUT) });
    log("search", { path: sanitizePath(searchUrl), status: sRes.status });
    if (!sRes.ok) throw new Error(`search HTTP ${sRes.status}`);
    const candidates = ((await sRes.json()).data ?? []) as Array<{
      id: number;
      type: string;
    }>;

    let internalId: number | null = null;
    let episodeId: number | null = null;
    let tipoCasado = "";

    // O endpoint do detalhe vem do `type` da propria busca. Assumir
    // "tudo que nao e movie e series" quebrava anime em silencio: os IDs sao
    // namespaces separados — animes/3827 e "Hunter x Hunter" (tmdb 46298) e
    // series/3827 e "Beijar ou Morrer" (tmdb 296263). O tmdb_id nao batia e o
    // candidato era descartado como "nao encontrado".
    const endpointDe = (tipo: string): string | null => {
      switch (String(tipo).toLowerCase()) {
        case "movie": return "movies";
        case "series": return "series";
        case "anime": return "animes";
        default: return null;
      }
    };

    for (const c of candidates.slice(0, 8)) {
      const endpoint = endpointDe(c.type);
      if (!endpoint) continue;
      // Filme so casa com filme; serie e anime sao ambos episodicos.
      if (isMovie !== (endpoint === "movies")) continue;
      const dUrl = `${cfg.base}/${endpoint}/${c.id}?profile_id=${encodeURIComponent(cfg.profileId)}`;
      const dRes = await fetch(dUrl, { headers: H, signal: AbortSignal.timeout(TIMEOUT) });
      log("detail", { path: sanitizePath(dUrl), status: dRes.status, tipo: c.type });
      if (!dRes.ok) continue;
      const detail = await dRes.json();
      if (String(detail.tmdb_id) !== String(q.tmdbId)) continue;
      internalId = c.id;
      tipoCasado = c.type;
      if (!isMovie) {
        // [RUNTIME] shape de temporadas/episódios do /api/v1/ ainda não validado.
        const seasons = (detail.seasons ?? []) as Array<{
          number: number;
          episodes: Array<{ id: number; number: number }>;
        }>;
        const ep = seasons
          .find((s) => s.number === season)
          ?.episodes.find((e) => e.number === episode);
        if (ep) episodeId = ep.id;
      }
      break;
    }

    if (!internalId || (!isMovie && !episodeId)) {
      log("not_found", { ms: Date.now() - t0, tmdb: q.tmdbId, type: q.type });
      return null;
    }
    log("found", { ms: Date.now() - t0, internalId, episodeId: episodeId ?? "-", tipo: tipoCasado });

    // 2. Lista de servidores.  [BYTECODE] streaming/movies/{id}/videos | episodes/{id}/videos
    const videosUrl = isMovie
      ? `${cfg.base}/streaming/movies/${internalId}/videos?platform=${cfg.platform}&device_type=${cfg.deviceType}`
      : `${cfg.base}/streaming/episodes/${episodeId}/videos?platform=${cfg.platform}&device_type=${cfg.deviceType}&profile_id=${encodeURIComponent(cfg.profileId)}`;
    const vRes = await fetch(videosUrl, { headers: H, signal: AbortSignal.timeout(TIMEOUT) });
    log("videos", { path: sanitizePath(videosUrl), status: vRes.status });
    if (!vRes.ok) throw new Error(`videos HTTP ${vRes.status}`);
    const vData = await vRes.json();

    // has_subscription=false → conteúdo bloqueado. NÃO tentamos burlar ad-gate.
    if (vData.has_subscription === false) {
      log("no_sub", { note: "conta sem assinatura para este título; ad-gate NÃO é contornado" });
      return null;
    }

    const subtitles: CineVsSubtitle[] = ((vData.subtitles ?? []) as Array<{
      language?: string;
      label?: string;
      url?: string;
    }>)
      .filter((s) => s.url)
      .map((s) => ({ language: s.language ?? "", label: s.label ?? "", url: s.url! }));

    const videos = (vData.videos ?? []) as Array<{
      id: number;
      audio_type: string;
      is_premium: boolean;
      is_code?: boolean;
      locked: boolean;
      sort_order?: number;
    }>;
    if (videos.length === 0) {
      log("no_videos", { ms: Date.now() - t0 });
      return null;
    }

    // TODAS as opcoes viram fontes rotuladas — e nao so a primeira que resolve.
    // Listar nao custa chamada nenhuma: `/videos` ja foi buscado acima.
    const fontes = rotularFontes(videos, {
      temAssinatura: vData.has_subscription !== false,
      temVip: vData.has_vip_access !== false,
    });
    log("fontes", {
      total: fontes.length,
      rotulos: fontes.map((f) => `${f.label}${f.disponivel ? "" : "!"}`).join("|"),
    });

    // Fonte pedida pelo usuario tem prioridade absoluta; sem pedido, tenta as
    // disponiveis na ordem do provedor. Indisponivel nunca entra na tentativa
    // automatica — nao ha contorno de restricao aqui.
    const porId = (id: number) => videos.find((v) => v.id === id);
    const pedida = q.videoId ? porId(q.videoId) : null;
    if (q.videoId && !pedida) {
      log("video_inexistente", { videoId: q.videoId });
      return null;
    }
    if (pedida) {
      const meta = fontes.find((f) => f.videoId === pedida.id);
      if (meta && !meta.disponivel) {
        log("fonte_indisponivel", { videoId: pedida.id, motivo: meta.motivoIndisponivel ?? "?" });
        return null;
      }
    }

    const disponiveis = new Set(fontes.filter((f) => f.disponivel).map((f) => f.videoId));
    const eligible = pedida
      ? [pedida]
      : videos.filter((v) => disponiveis.has(v.id)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    if (eligible.length === 0) {
      log("nenhuma_disponivel", { ms: Date.now() - t0, total: fontes.length });
      return null;
    }

    // 3. Para a fonte escolhida: /video/{videoId} → payload → resolve-url.
    for (const video of eligible) {
      const detailUrl = isMovie
        ? `${cfg.base}/streaming/movies/${internalId}/video/${video.id}?device_id=${encodeURIComponent(cfg.deviceId)}&profile_id=${encodeURIComponent(cfg.profileId)}&device_name=Obaflix&device_type=${cfg.deviceType}&platform=${cfg.platform}`
        : `${cfg.base}/streaming/episodes/${episodeId}/video/${video.id}?device_id=${encodeURIComponent(cfg.deviceId)}&profile_id=${encodeURIComponent(cfg.profileId)}&device_name=Obaflix&device_type=${cfg.deviceType}&platform=${cfg.platform}`;

      // O campo `video_url` NÃO é uma URL: é um payload cifrado que só a própria
      // API sabe abrir. A doc antiga dizia que o resolve-url não era usado —
      // isso valia para o fluxo do APK; o fluxo web exige, e é este que roda aqui.
      let payload: string;
      let sessionId: number | string | null = null;
      try {
        const r = await fetch(detailUrl, { headers: H, signal: AbortSignal.timeout(TIMEOUT) });
        log("video", { path: sanitizePath(detailUrl), status: r.status, videoId: video.id, audio: video.audio_type });
        if (!r.ok) continue;
        const d = await r.json();
        payload = d.video_url;
        sessionId = d.session_id ?? null;
        // `extracted_subtitles` so existe no detalhe da fonte e estava sendo
        // descartado. Soma-se as legendas do nivel do episodio, sem repetir url.
        for (const es of (d.extracted_subtitles ?? []) as Array<{ language?: string; label?: string; url?: string }>) {
          if (es.url && !subtitles.some((x) => x.url === es.url)) {
            subtitles.push({ language: es.language ?? "", label: es.label ?? "", url: es.url });
          }
        }
        if (!payload) {
          log("video_no_url", { videoId: video.id });
          continue;
        }
      } catch {
        continue;
      }

      // resolve-url exige payload E session_id. Sem o segundo devolve 422
      // ("The session id field is required.").
      let finalUrl: string;
      try {
        const r = await fetch(`${cfg.base}/streaming/resolve-url`, {
          method: "POST",
          headers: { ...H, "Content-Type": "application/json" },
          body: JSON.stringify({ payload, session_id: sessionId }),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        log("resolve", { status: r.status, videoId: video.id });
        if (!r.ok) continue;
        const d = await r.json();
        finalUrl = d.url;
        if (!finalUrl) {
          log("resolve_no_url", { videoId: video.id });
          continue;
        }
        // O provedor devolve algumas URLs em http://. O Android recusa
        // cleartext desde a API 28 ("CLEARTEXT communication not permitted"),
        // e navegador nenhum aceita mídia http dentro de página https. Medido
        // em 01/09/2026: o host responde igual nos dois esquemas, sem redirect
        // de https para http — é Cloudflare na frente, que sempre serve TLS.
        // Então subir o esquema é seguro e evita abrir exceção de cleartext no
        // aplicativo, que valeria para todo o host.
        if (finalUrl.startsWith("http://")) {
          finalUrl = "https://" + finalUrl.slice("http://".length);
          log("https_forcado", { host: mediaHost(finalUrl) });
        }
      } catch {
        continue;
      }

      // Só HLS precisa de CORS: o MP4 toca em <video src> sem ele. A prova custa
      // uma requisicao e evita ~188 MB de Transfer Out por episodio (medido).
      const formatoFinal = detectFormat(finalUrl);
      const corsLiberado = formatoFinal === "HLS"
        ? await corsPermiteDireto(finalUrl, TIMEOUT)
        : false;

      log("ok", {
        ms: Date.now() - t0,
        videoId: video.id,
        audio: video.audio_type,
        mediaHost: mediaHost(finalUrl),
        format: formatoFinal,
        hasExpiry: hasExpiryParams(finalUrl),
        subs: subtitles.length,
        cors: corsLiberado ? "liberado" : "restrito",
      });

      return {
        streamUrl: finalUrl,
        // Medido: o CDN devolve 200 sem Referer e com Origin de qualquer site.
        // Não mandar Referer é o que permite a mídia ir direto ao dispositivo
        // nos três ambientes, sem passar pelo proxy da Vercel.
        referer: null,
        format: detectFormat(finalUrl),
        mediaHost: mediaHost(finalUrl),
        hasExpiry: hasExpiryParams(finalUrl),
        audioType: video.audio_type,
        subtitles,
        fontes,
        videoId: video.id,
        corsLiberado,
      };
    }

    log("all_failed", { ms: Date.now() - t0, tried: eligible.length });
    return null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log("error", { ms: Date.now() - t0, err: msg.slice(0, 120) });
    return null;
  }
}
