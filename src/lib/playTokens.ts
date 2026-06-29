/**
 * Camada criptográfica da reprodução.
 *
 * PlayToken   — autoriza uma extração (HMAC-SHA256, TTL 5 min, vinculado a userId+IP+embedUrl)
 * StreamToken — carrega a URL CDN criptografada (AES-256-GCM, TTL 20 min, uso único, vinculado a userId+IP+UA)
 * SegmentSig  — HMAC dos segmentos M3U8 reescritos, vinculado ao userId da sessão
 *
 * Rotação de chave: a chave mestre muda semanalmente; tokens criados na semana anterior
 * continuam válidos durante o período de transição (tentativa com chave anterior).
 *
 * Single-use: stream tokens são marcados como consumidos no primeiro uso.
 * Best-effort em serverless (per-instance); TTL curto compensa falta de estado global.
 *
 * Reproduções simultâneas: máximo de 3 streams ativos por userId (per-instance).
 *
 * Bloqueio temporário: após 10 tokens inválidos num minuto, IP é bloqueado por 5 min.
 */

import crypto from "crypto";

// ── Chave com rotação semanal ─────────────────────────────────────────────────

function weekNumber(): number {
  return Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
}

function deriveKey(week: number): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET não configurado");
  return crypto
    .createHash("sha256")
    .update(`${secret}:week:${week}`)
    .digest();
}

/** Retorna [chave_atual, chave_anterior] para descriptografia tolerante à rotação */
function keys(): [Buffer, Buffer] {
  const w = weekNumber();
  return [deriveKey(w), deriveKey(w - 1)];
}

function currentKey(): Buffer {
  return keys()[0];
}

// ── Helpers criptográficos ────────────────────────────────────────────────────

function hmacSign(data: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(data).digest("base64url");
}

function hmacVerifyWith(data: string, sig: string, key: Buffer): boolean {
  const expected = Buffer.from(hmacSign(data, key));
  const received = Buffer.from(sig);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

function hashUrl(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── Single-use registry (stream tokens) ──────────────────────────────────────

const usedTokens = new Map<string, number>(); // tokenHash → usedAt

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of usedTokens) if (v < cutoff) usedTokens.delete(k);
}, 5 * 60 * 1000);

function markUsed(token: string): boolean {
  const h = hashToken(token);
  if (usedTokens.has(h)) return false; // já foi usado
  usedTokens.set(h, Date.now());
  return true;
}

// ── Simultaneous playback limit ───────────────────────────────────────────────

interface ActiveStream { tokenHash: string; expiresAt: number; }
const activeStreams = new Map<string, ActiveStream[]>(); // userId → streams
const MAX_CONCURRENT = 3;

function registerStream(userId: string, tokenHash: string, expiresAt: number): boolean {
  const now = Date.now();
  const existing = (activeStreams.get(userId) ?? []).filter(s => s.expiresAt > now);
  if (existing.length >= MAX_CONCURRENT) return false;
  existing.push({ tokenHash, expiresAt });
  activeStreams.set(userId, existing);
  return true;
}

// ── Bloqueio temporário por IP ────────────────────────────────────────────────

interface AbuseRecord { count: number; windowStart: number; blockedUntil: number; }
const abuseMap = new Map<string, AbuseRecord>();
const ABUSE_WINDOW_MS = 60_000;
const ABUSE_THRESHOLD = 10;
const BLOCK_DURATION_MS = 5 * 60_000;

export function recordAbuseAttempt(ip: string): void {
  const now = Date.now();
  let rec = abuseMap.get(ip);
  if (!rec || now - rec.windowStart > ABUSE_WINDOW_MS) {
    rec = { count: 1, windowStart: now, blockedUntil: 0 };
  } else {
    rec.count++;
    if (rec.count >= ABUSE_THRESHOLD) {
      rec.blockedUntil = now + BLOCK_DURATION_MS;
    }
  }
  abuseMap.set(ip, rec);
}

export function isIpBlocked(ip: string): boolean {
  const rec = abuseMap.get(ip);
  if (!rec) return false;
  return rec.blockedUntil > Date.now();
}

// ── Rate limit simples por userId ─────────────────────────────────────────────

const rateBucket = new Map<string, { count: number; resetAt: number }>();
const MAX_TOKENS_PER_MINUTE = 20;

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  let bucket = rateBucket.get(userId);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateBucket.set(userId, bucket);
  }
  if (bucket.count >= MAX_TOKENS_PER_MINUTE) return false;
  bucket.count++;
  return true;
}

// ── PlayToken ─────────────────────────────────────────────────────────────────

interface PlayTokenPayload {
  uid: string;
  eh: string;    // hash da embedUrl
  ih: string;    // hash do IP do solicitante
  exp: number;
  n: string;     // nonce
}

const PLAY_TOKEN_TTL_MS = 5 * 60 * 1000;

export function createPlayToken(userId: string, embedUrl: string, clientIp: string): string {
  const payload: PlayTokenPayload = {
    uid: userId,
    eh: hashUrl(embedUrl),
    ih: hashUrl(clientIp),
    exp: Date.now() + PLAY_TOKEN_TTL_MS,
    n: crypto.randomBytes(8).toString("base64url"),
  };
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmacSign(json, currentKey());
  return `${json}.${sig}`;
}

export function verifyPlayToken(
  token: string,
  userId: string,
  embedUrl: string,
  clientIp: string,
): { ok: boolean; ipMismatch?: boolean } {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return { ok: false };
  const json = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Tenta chave atual e chave anterior (tolerância à rotação semanal)
  const [kCurr, kPrev] = keys();
  if (!hmacVerifyWith(json, sig, kCurr) && !hmacVerifyWith(json, sig, kPrev)) {
    return { ok: false };
  }

  try {
    const p = JSON.parse(Buffer.from(json, "base64url").toString()) as PlayTokenPayload;
    if (p.exp < Date.now()) return { ok: false };
    if (p.uid !== userId) return { ok: false };
    if (p.eh !== hashUrl(embedUrl)) return { ok: false };
    const ipMismatch = p.ih !== hashUrl(clientIp);
    // IP mismatch não é fatal (redes móveis / NAT) — apenas sinaliza para log
    return { ok: true, ipMismatch };
  } catch { return { ok: false }; }
}

// ── StreamToken ───────────────────────────────────────────────────────────────

interface StreamTokenPayload {
  uid: string;
  url: string;       // URL CDN criptografada junto com o payload
  ref: string | null;
  ih: string;        // hash do IP
  uah: string;       // hash do User-Agent
  exp: number;
}

const STREAM_TOKEN_TTL_MS = 20 * 60 * 1000;

export function createStreamToken(
  userId: string,
  streamUrl: string,
  referer: string | null,
  clientIp: string,
  userAgent: string,
): { token: string; accepted: boolean } {
  const expiresAt = Date.now() + STREAM_TOKEN_TTL_MS;
  const tokenHash = crypto.randomBytes(16).toString("hex"); // placeholder para registro

  if (!registerStream(userId, tokenHash, expiresAt)) {
    return { token: "", accepted: false };
  }

  const payload: StreamTokenPayload = {
    uid: userId,
    url: streamUrl,
    ref: referer ?? null,
    ih: hashUrl(clientIp),
    uah: hashUrl(userAgent),
    exp: expiresAt,
  };

  const plain = JSON.stringify(payload);
  const key = currentKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const token = `${iv.toString("base64url")}.${enc.toString("base64url")}.${tag.toString("base64url")}`;
  return { token, accepted: true };
}

export function resolveStreamToken(
  token: string,
  userId: string,
  clientIp: string,
  userAgent: string,
): { streamUrl: string; referer: string | null; ipMismatch?: boolean } | null {
  // Single-use: rejeita se já foi consumido
  if (!markUsed(token)) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [kCurr, kPrev] = keys();

  for (const key of [kCurr, kPrev]) {
    try {
      const iv = Buffer.from(parts[0], "base64url");
      const enc = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[2], "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
      const p = JSON.parse(plain) as StreamTokenPayload;
      if (p.exp < Date.now()) return null;
      if (p.uid !== userId) return null;
      // UA mismatch é fatal (indica reutilização por outro cliente)
      if (p.uah !== hashUrl(userAgent)) return null;
      const ipMismatch = p.ih !== hashUrl(clientIp);
      return { streamUrl: p.url, referer: p.ref, ipMismatch };
    } catch { /* tenta próxima chave */ }
  }
  return null;
}

// ── SegmentSig ────────────────────────────────────────────────────────────────

export function signSegmentUrl(url: string, userId: string): string {
  return crypto
    .createHmac("sha256", currentKey())
    .update(`${userId}:${url}`)
    .digest("base64url")
    .slice(0, 22);
}

export function verifySegmentUrl(url: string, userId: string, sig: string): boolean {
  const [kCurr, kPrev] = keys();
  for (const key of [kCurr, kPrev]) {
    const expected = crypto
      .createHmac("sha256", key)
      .update(`${userId}:${url}`)
      .digest("base64url")
      .slice(0, 22);
    if (expected.length === sig.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return true;
      } catch { /**/ }
    }
  }
  return false;
}
