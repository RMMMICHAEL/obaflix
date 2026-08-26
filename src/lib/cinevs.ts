// ─────────────────────────────────────────────────────────────────────────────
// extractCineVs — extrator ISOLADO e DESATIVADO por padrão.
//
// Reproduz APENAS o fluxo comprovado no bytecode do app `tv16.apk`
// (package com.cnvs.apptv, base `/api/v1/`):
//
//     autenticação autorizada (refresh) → /videos → /video/{videoId} → video_url
//
// Diferenças deliberadas em relação ao extractWebcine (base `/api/`):
//   • NÃO usa `resolve-url` (esse passo não existe no pipeline /api/v1/).
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
export function cineVsConfig(requireCreds = true): CineVsConfig {
  const base = (process.env.CINEVS_API_BASE ?? "").replace(/\/+$/, "");
  const refreshToken = process.env.CINEVS_REFRESH_TOKEN ?? "";
  const missing: string[] = [];
  if (requireCreds && !base) missing.push("CINEVS_API_BASE");
  if (requireCreds && !refreshToken) missing.push("CINEVS_REFRESH_TOKEN");
  if (missing.length) {
    throw new CineVsConfigError(
      `Variáveis ausentes: ${missing.join(", ")}. Veja docs/cinevs-diagnostico.md.`,
    );
  }
  return {
    base,
    refreshToken,
    deviceId: process.env.CINEVS_DEVICE_ID ?? "",
    profileId: process.env.CINEVS_PROFILE_ID ?? "",
    authPath: (process.env.CINEVS_AUTH_PATH ?? "auth/refresh").replace(/^\/+/, ""),
    platform: process.env.CINEVS_PLATFORM ?? "web",
    deviceType: process.env.CINEVS_DEVICE_TYPE ?? "web",
    clientPlatform: process.env.CINEVS_CLIENT_PLATFORM ?? "",
    enabled: process.env.CINEVS_ENABLED === "1" || process.env.CINEVS_ENABLED === "true",
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
function authHeaders(cfg: CineVsConfig, token: string): Record<string, string> {
  const h: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "x-device-id": cfg.deviceId,
    "Accept": "application/json",
    "User-Agent": UA,
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
  referer: string;
  format: ReturnType<typeof detectFormat>;
  mediaHost: string;
  hasExpiry: boolean;
  audioType: string;
  subtitles: CineVsSubtitle[];
}

export interface CineVsQuery {
  tmdbId: string;
  type: "movie" | "tv";
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

    for (const c of candidates.slice(0, 8)) {
      if (isMovie !== (c.type === "movie")) continue;
      const endpoint = isMovie ? "movies" : "series";
      const dUrl = `${cfg.base}/${endpoint}/${c.id}?profile_id=${encodeURIComponent(cfg.profileId)}`;
      const dRes = await fetch(dUrl, { headers: H, signal: AbortSignal.timeout(TIMEOUT) });
      log("detail", { path: sanitizePath(dUrl), status: dRes.status });
      if (!dRes.ok) continue;
      const detail = await dRes.json();
      if (String(detail.tmdb_id) !== String(q.tmdbId)) continue;
      internalId = c.id;
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
    log("found", { ms: Date.now() - t0, internalId, episodeId: episodeId ?? "-" });

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
      locked: boolean;
      sort_order?: number;
    }>;
    if (videos.length === 0) {
      log("no_videos", { ms: Date.now() - t0 });
      return null;
    }

    // Prioriza servidores desbloqueados (dublado → outros). Premium/locked = último recurso,
    // sem forjar prova de anúncio: se exigir X-Ad-Proof, o servidor recusará e seguimos.
    const eligible = [
      ...videos.filter((v) => !v.is_premium && !v.locked && v.audio_type === "dubbed"),
      ...videos.filter((v) => !v.is_premium && !v.locked && v.audio_type !== "dubbed"),
      ...videos.filter((v) => v.is_premium || v.locked),
    ];

    // 3. Para cada servidor: /video/{videoId} → video_url (SEM resolve-url).  [BYTECODE]
    for (const video of eligible) {
      const detailUrl = isMovie
        ? `${cfg.base}/streaming/movies/${internalId}/video/${video.id}?device_id=${encodeURIComponent(cfg.deviceId)}&profile_id=${encodeURIComponent(cfg.profileId)}&device_type=${cfg.deviceType}&platform=${cfg.platform}`
        : `${cfg.base}/streaming/episodes/${episodeId}/video/${video.id}?device_id=${encodeURIComponent(cfg.deviceId)}&profile_id=${encodeURIComponent(cfg.profileId)}&device_type=${cfg.deviceType}&platform=${cfg.platform}`;

      let videoUrl: string;
      try {
        const r = await fetch(detailUrl, { headers: H, signal: AbortSignal.timeout(TIMEOUT) });
        log("video", { path: sanitizePath(detailUrl), status: r.status, videoId: video.id, audio: video.audio_type });
        if (!r.ok) continue; // 401/403 aqui ⇒ possivelmente atestado/ad-proof exigido [RUNTIME]
        const d = await r.json();
        videoUrl = d.video_url;
        if (!videoUrl) {
          log("video_no_url", { videoId: video.id });
          continue;
        }
      } catch {
        continue;
      }

      const format = detectFormat(videoUrl);
      const host = mediaHost(videoUrl);
      const expiry = hasExpiryParams(videoUrl);

      // 4. Diagnóstico do redirect/expiração via HEAD (não baixa mídia).  [RUNTIME]
      // HEAD não transfere corpo; serve só para observar status/redirect e validar o host.
      let finalUrl = videoUrl;
      try {
        const head = await fetch(videoUrl, {
          method: "HEAD",
          headers: { "User-Agent": UA },
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        });
        const loc = head.headers.get("location");
        log("head", {
          status: head.status,
          redirect: loc ? "yes" : "no",
          mediaHost: host,
          format,
          hasExpiry: expiry,
        });
        if (loc && (head.status === 301 || head.status === 302 || head.status === 307 || head.status === 308)) {
          finalUrl = loc;
        }
      } catch {
        log("head_err", { mediaHost: host, format, hasExpiry: expiry, note: "HEAD falhou; usando URL original" });
      }

      log("ok", {
        ms: Date.now() - t0,
        videoId: video.id,
        audio: video.audio_type,
        mediaHost: mediaHost(finalUrl),
        format: detectFormat(finalUrl),
        hasExpiry: hasExpiryParams(finalUrl),
        subs: subtitles.length,
      });

      return {
        streamUrl: finalUrl,
        referer: `${new URL(cfg.base).origin}/`,
        format: detectFormat(finalUrl),
        mediaHost: mediaHost(finalUrl),
        hasExpiry: hasExpiryParams(finalUrl),
        audioType: video.audio_type,
        subtitles,
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
