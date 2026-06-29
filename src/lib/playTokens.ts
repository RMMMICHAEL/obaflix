/**
 * Token criptográfico para a camada de reprodução.
 *
 * PlayToken  — prova que o servidor autorizou a extração para este userId+embedUrl.
 *              Payload visível, assinado com HMAC-SHA256. TTL 5 min.
 *
 * StreamToken — carrega a URL CDN criptografada (AES-256-GCM) para que o browser
 *               nunca receba a URL real do stream. TTL 20 min.
 *
 * SegmentSig  — assinatura HMAC dos segmentos reescritos no M3U8, vinculada ao
 *               userId da sessão. Impede que a URL copiada funcione em outra sessão.
 */

import crypto from "crypto";

// ── Chave derivada do NEXTAUTH_SECRET ─────────────────────────────────────────

function masterKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET não configurado");
  return crypto.createHash("sha256").update(secret).digest();
}

// ── Helpers internos ──────────────────────────────────────────────────────────

function hashUrl(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** HMAC-SHA256 assinado com timing-safe compare */
function hmacSign(data: string): string {
  return crypto.createHmac("sha256", masterKey()).update(data).digest("base64url");
}

function hmacVerify(data: string, sig: string): boolean {
  const expected = Buffer.from(hmacSign(data));
  const received = Buffer.from(sig);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

// ── PlayToken ─────────────────────────────────────────────────────────────────

interface PlayTokenPayload {
  uid: string;
  eh: string;   // hash da embedUrl
  exp: number;
  n: string;    // nonce aleatório
}

const PLAY_TOKEN_TTL_MS = 5 * 60 * 1000;

export function createPlayToken(userId: string, embedUrl: string): string {
  const payload: PlayTokenPayload = {
    uid: userId,
    eh: hashUrl(embedUrl),
    exp: Date.now() + PLAY_TOKEN_TTL_MS,
    n: crypto.randomBytes(8).toString("base64url"),
  };
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmacSign(json);
  return `${json}.${sig}`;
}

export function verifyPlayToken(token: string, userId: string, embedUrl: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;
  const json = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!hmacVerify(json, sig)) return false;
  try {
    const p = JSON.parse(Buffer.from(json, "base64url").toString()) as PlayTokenPayload;
    if (p.exp < Date.now()) return false;
    if (p.uid !== userId) return false;
    if (p.eh !== hashUrl(embedUrl)) return false;
    return true;
  } catch { return false; }
}

// ── StreamToken (URL CDN criptografada) ───────────────────────────────────────

interface StreamTokenPayload {
  uid: string;
  url: string;
  ref: string | null;
  exp: number;
}

const STREAM_TOKEN_TTL_MS = 20 * 60 * 1000;

export function createStreamToken(userId: string, streamUrl: string, referer: string | null): string {
  const payload: StreamTokenPayload = {
    uid: userId,
    url: streamUrl,
    ref: referer ?? null,
    exp: Date.now() + STREAM_TOKEN_TTL_MS,
  };
  const plain = JSON.stringify(payload);
  const key = masterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${enc.toString("base64url")}.${tag.toString("base64url")}`;
}

export function resolveStreamToken(
  token: string,
  userId: string,
): { streamUrl: string; referer: string | null } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], "base64url");
    const enc = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const key = masterKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    const p = JSON.parse(plain) as StreamTokenPayload;
    if (p.exp < Date.now()) return null;
    if (p.uid !== userId) return null;
    return { streamUrl: p.url, referer: p.ref };
  } catch { return null; }
}

// ── SegmentSig (HMAC para segmentos reescritos no M3U8) ───────────────────────

/** Assina `userId:segmentUrl` — vincula o segmento à sessão que gerou o M3U8 */
export function signSegmentUrl(url: string, userId: string): string {
  return crypto
    .createHmac("sha256", masterKey())
    .update(`${userId}:${url}`)
    .digest("base64url")
    .slice(0, 22);
}

export function verifySegmentUrl(url: string, userId: string, sig: string): boolean {
  const expected = signSegmentUrl(url, userId);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
