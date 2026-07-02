/**
 * Camada criptográfica da reprodução — estado centralizado em Redis.
 *
 * PlayToken   — HMAC-SHA256, TTL 5 min, vinculado a userId+IP+embedUrl
 * StreamToken — AES-256-GCM, TTL 20 min, uso único (NX no Redis), vinculado a userId+IP+UA
 * SegmentSig  — HMAC dos segmentos M3U8, vinculado ao userId
 *
 * Rotação de chave: semanal, com janela de transição (tenta chave atual e anterior).
 * Estado distribuído: single-use, bloqueios, rate limit e streams simultâneos
 * ficam no Redis — funcionam corretamente em múltiplas instâncias serverless.
 * Fallback: se Redis não estiver configurado, usa Maps in-memory (dev local).
 */

import crypto from "crypto";
import { getRedis } from "./redis";
import { audit } from "./auditLog";

// ── Prefixos das chaves Redis ─────────────────────────────────────────────────

const KEY = {
  usedToken:   (h: string) => `play:used:${h}`,
  ipBlock:     (h: string) => `play:block:${h}`,
  ipAbuse:     (h: string) => `play:abuse:${h}`,
  rateLimit:   (id: string) => `play:rate:${id}`,
  activeStreams:(id: string) => `play:streams:${id}`,
};

// ── Diagnóstico de ciclo de vida dos tokens ───────────────────────────────────
// Logs estruturados para validar ZADD/ZREM e consistência do sorted set.
// Prefixo [token/<fase>] uid=...XXXX — pesquisável nos logs do Vercel.
// Remover quando a correção do ZREM estiver confirmada.

function tlog(phase: string, userId: string, data: Record<string, string | number | boolean | null | undefined>) {
  const parts = Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[token/${phase}] uid=...${userId.slice(-8)} ${parts}`);
}

// ── Rotação semanal de chave ──────────────────────────────────────────────────

function weekNumber(): number {
  return Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
}

function deriveKey(week: number): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET não configurado");
  return crypto.createHash("sha256").update(`${secret}:week:${week}`).digest();
}

function keys(): [Buffer, Buffer] {
  const w = weekNumber();
  return [deriveKey(w), deriveKey(w - 1)];
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
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
}

// ── Bloqueio temporário por IP (Redis) ───────────────────────────────────────

const ABUSE_WINDOW_SEC = 60;
const ABUSE_THRESHOLD = 10;
const BLOCK_SEC = 5 * 60;

export async function recordAbuseAttempt(ip: string): Promise<void> {
  const redis = getRedis();
  const h = hashUrl(ip);
  const abuseKey = KEY.ipAbuse(h);
  const count = await redis.incr(abuseKey);
  if (count === 1) await redis.expire(abuseKey, ABUSE_WINDOW_SEC);
  if (count >= ABUSE_THRESHOLD) {
    await redis.set(KEY.ipBlock(h), "1", { ex: BLOCK_SEC });
    audit("ip_blocked", { ip });
  }
}

export async function isIpBlocked(ip: string): Promise<boolean> {
  const redis = getRedis();
  const val = await redis.get(KEY.ipBlock(hashUrl(ip)));
  return val === "1";
}

// ── Rate limit por userId (Redis) ─────────────────────────────────────────────

const MAX_TOKENS_PER_MINUTE = 20;

export async function checkRateLimit(userId: string): Promise<boolean> {
  const redis = getRedis();
  const key = KEY.rateLimit(userId);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  if (count > MAX_TOKENS_PER_MINUTE) {
    audit("rate_limited", { userId });
    return false;
  }
  return true;
}

// ── Single-use stream tokens (Redis NX) ──────────────────────────────────────

const TOKEN_USED_TTL_SEC = 30 * 60;

/** Retorna true se o token ainda não foi consumido (e o marca como usado) */
async function markUsed(token: string): Promise<boolean> {
  const redis = getRedis();
  const h = hashToken(token);
  const result = await redis.set(KEY.usedToken(h), "1", {
    ex: TOKEN_USED_TTL_SEC,
    nx: true, // SET NX → falha se a chave já existir (atômico no Redis)
  });
  const firstUse = result === "OK";
  console.log(`[token/markUsed] th=${h.slice(0, 8)} firstUse=${firstUse}`);
  return firstUse;
}

// ── Limite de streams simultâneos (Redis sorted set por expiresAt) ────────────

const MAX_CONCURRENT = 3;

async function registerStream(userId: string, tokenHash: string, expiresAt: number): Promise<boolean> {
  const redis = getRedis();
  const key = KEY.activeStreams(userId);
  const now = Date.now();

  // Remove streams expirados do sorted set antes de contar
  const expiredRemoved = await redis.zremrangebyscore(key, 0, now);

  const before = await redis.zcard(key);
  if (before >= MAX_CONCURRENT) {
    const ttlSec = await redis.ttl(key);
    tlog("register/rejected", userId, {
      th: tokenHash.slice(0, 8),
      before,
      max: MAX_CONCURRENT,
      expiredRemoved: expiredRemoved ?? null,
      ttlSec,
    });
    audit("concurrent_limit", { userId, detail: `${before} streams ativos` });
    return false;
  }

  await redis.zadd(key, expiresAt, tokenHash);
  // TTL do sorted set = expiração do token mais longo possível + margem
  await redis.expire(key, Math.ceil((expiresAt - now) / 1000) + 60);
  const after = await redis.zcard(key);
  const ttlSec = await redis.ttl(key);
  tlog("register/ok", userId, {
    th: tokenHash.slice(0, 8),
    before,
    after,
    expiresInSec: Math.round((expiresAt - now) / 1000),
    ttlSec,
    expiredRemoved: expiredRemoved ?? null,
  });
  return true;
}

// ── PlayToken ─────────────────────────────────────────────────────────────────

interface PlayTokenPayload {
  uid: string;
  eh: string;   // hash da embedUrl
  ih: string;   // hash do IP
  exp: number;
  n: string;    // nonce
}

const PLAY_TOKEN_TTL_MS = 5 * 60 * 1000;

export function createPlayToken(userId: string, embedUrl: string, clientIp: string): string {
  const [key] = keys();
  const payload: PlayTokenPayload = {
    uid: userId,
    eh: hashUrl(embedUrl),
    ih: hashUrl(clientIp),
    exp: Date.now() + PLAY_TOKEN_TTL_MS,
    n: crypto.randomBytes(8).toString("base64url"),
  };
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmacSign(json, key);
  audit("play_token_issued", { userId, ip: clientIp });
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

  const [kCurr, kPrev] = keys();
  if (!hmacVerifyWith(json, sig, kCurr) && !hmacVerifyWith(json, sig, kPrev)) return { ok: false };

  try {
    const p = JSON.parse(Buffer.from(json, "base64url").toString()) as PlayTokenPayload;
    if (p.exp < Date.now()) return { ok: false };
    if (p.uid !== userId) return { ok: false };
    if (p.eh !== hashUrl(embedUrl)) return { ok: false };
    return { ok: true, ipMismatch: p.ih !== hashUrl(clientIp) };
  } catch { return { ok: false }; }
}

// ── StreamToken ───────────────────────────────────────────────────────────────

interface StreamTokenPayload {
  uid: string;
  url: string;
  ref: string | null;
  ih: string;   // hash do IP
  uah: string;  // hash do User-Agent
  exp: number;
  th: string;   // token hash para o sorted set de streams ativos
}

const STREAM_TOKEN_TTL_MS = 20 * 60 * 1000;

export async function createStreamToken(
  userId: string,
  streamUrl: string,
  referer: string | null,
  clientIp: string,
  userAgent: string,
): Promise<{ token: string; accepted: boolean }> {
  const expiresAt = Date.now() + STREAM_TOKEN_TTL_MS;
  const th = crypto.randomBytes(12).toString("hex");

  const accepted = await registerStream(userId, th, expiresAt);
  if (!accepted) return { token: "", accepted: false };
  tlog("create", userId, { th: th.slice(0, 8), expiresInSec: Math.round(STREAM_TOKEN_TTL_MS / 1000) });

  const [key] = keys();
  const payload: StreamTokenPayload = {
    uid: userId,
    url: streamUrl,
    ref: referer ?? null,
    ih: hashUrl(clientIp),
    uah: hashUrl(userAgent),
    exp: expiresAt,
    th,
  };

  const plain = JSON.stringify(payload);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const token = `${iv.toString("base64url")}.${enc.toString("base64url")}.${tag.toString("base64url")}`;

  audit("stream_started", { userId, ip: clientIp, ua: userAgent, detail: `tipo: ${streamUrl.includes(".mp4") ? "mp4" : "hls"}` });
  return { token, accepted: true };
}

export async function resolveStreamToken(
  token: string,
  userId: string,
  clientIp: string,
  userAgent: string,
): Promise<{ streamUrl: string; referer: string | null; ipMismatch?: boolean } | null> {
  // Single-use: SET NX no Redis — atômico, funciona em múltiplas instâncias
  const used = await markUsed(token);
  if (!used) {
    audit("stream_rejected", { userId, ip: clientIp, detail: "token já consumido" });
    return null;
  }

  const [kCurr, kPrev] = keys();
  const redis = getRedis();

  for (const key of [kCurr, kPrev]) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) continue;
      const iv = Buffer.from(parts[0], "base64url");
      const enc = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[2], "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
      const p = JSON.parse(plain) as StreamTokenPayload;

      if (p.exp < Date.now()) { audit("stream_rejected", { userId, ip: clientIp, detail: "token expirado" }); return null; }
      if (p.uid !== userId) { audit("stream_rejected", { userId, ip: clientIp, detail: "userId mismatch" }); return null; }
      if (p.uah !== hashUrl(userAgent)) { audit("stream_rejected", { userId, ip: clientIp, ua: userAgent, detail: "UA mismatch" }); return null; }

      const ipMismatch = p.ih !== hashUrl(clientIp);
      // Libera o slot no sorted set de streams ativos agora que o manifest foi
      // consumido. Segmentos subsequentes usam HMAC (signSegmentUrl), não o slot.
      // Isso permite troca de fonte sem acumular slots por 20 min (TTL do token).
      const streamKey = KEY.activeStreams(p.uid);
      const beforeZrem = await redis.zcard(streamKey);
      const zremCount = await redis.zrem(streamKey, p.th);
      const afterZrem = await redis.zcard(streamKey);
      const ttlSec = await redis.ttl(streamKey);
      tlog("zrem", p.uid, {
        th: p.th.slice(0, 8),
        removed: zremCount,   // 1 = ok, 0 = membro não encontrado (bug)
        before: beforeZrem,
        after: afterZrem,
        ttlSec,
      });
      return { streamUrl: p.url, referer: p.ref, ipMismatch };
    } catch { /* tenta próxima chave */ }
  }

  audit("stream_rejected", { userId, ip: clientIp, detail: "descriptografia falhou" });
  return null;
}

// ── SegmentSig ────────────────────────────────────────────────────────────────

export function signSegmentUrl(url: string, userId: string): string {
  const [key] = keys();
  return crypto.createHmac("sha256", key).update(`${userId}:${url}`).digest("base64url").slice(0, 22);
}

export function verifySegmentUrl(url: string, userId: string, sig: string): boolean {
  for (const key of keys()) {
    const expected = crypto.createHmac("sha256", key).update(`${userId}:${url}`).digest("base64url").slice(0, 22);
    if (expected.length === sig.length) {
      try { if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return true; } catch { /**/ }
    }
  }
  return false;
}
