import crypto from "crypto";
import { caminhoInternoSeguro } from "@/lib/billing/checkout";

export const DESKTOP_AUTH_AUDIENCE = "obaflix-desktop";
export const DESKTOP_AUTH_TTL_SECONDS = 180;

type TicketPayload = {
  v: 1;
  aud: typeof DESKTOP_AUTH_AUDIENCE;
  sub: string;
  ch: string;
  st: string;
  cb: string;
  iat: number;
  exp: number;
};

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function assinatura(body: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

function segredoValido(secret: string) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("desktop_auth_secret_invalido");
  return secret;
}

export function desafioPkce(verifier: string) {
  if (!VERIFIER_RE.test(verifier)) return null;
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function validarDesafioPkce(challenge: string | null | undefined): challenge is string {
  return typeof challenge === "string" && CHALLENGE_RE.test(challenge);
}

export function validarEstadoDesktop(state: string | null | undefined): state is string {
  return typeof state === "string" && STATE_RE.test(state);
}

export function callbackDesktopSeguro(value: string | null | undefined) {
  return caminhoInternoSeguro(value, "/desktop");
}

export function criarTicketDesktopAuth(
  input: { userId: string; challenge: string; state: string; callbackUrl: string },
  secret: string,
  nowMs = Date.now(),
) {
  segredoValido(secret);
  if (!input.userId || input.userId.length > 128) throw new Error("desktop_auth_user_invalido");
  if (!validarDesafioPkce(input.challenge)) throw new Error("desktop_auth_challenge_invalido");
  if (!validarEstadoDesktop(input.state)) throw new Error("desktop_auth_state_invalido");

  const now = Math.floor(nowMs / 1000);
  const payload: TicketPayload = {
    v: 1,
    aud: DESKTOP_AUTH_AUDIENCE,
    sub: input.userId,
    ch: input.challenge,
    st: input.state,
    cb: callbackDesktopSeguro(input.callbackUrl),
    iat: now,
    exp: now + DESKTOP_AUTH_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${assinatura(body, secret)}`;
}

export function verificarTicketDesktopAuth(ticket: string, secret: string, nowMs = Date.now()): TicketPayload | null {
  try {
    segredoValido(secret);
    if (typeof ticket !== "string" || ticket.length > 4096) return null;
    const parts = ticket.split(".");
    if (parts.length !== 2) return null;
    const [body, signature] = parts;
    const expected = assinatura(body, secret);
    if (signature.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketPayload;
    const now = Math.floor(nowMs / 1000);
    if (
      payload?.v !== 1 ||
      payload.aud !== DESKTOP_AUTH_AUDIENCE ||
      typeof payload.sub !== "string" ||
      payload.sub.length < 1 ||
      payload.sub.length > 128 ||
      !validarDesafioPkce(payload.ch) ||
      !validarEstadoDesktop(payload.st) ||
      callbackDesktopSeguro(payload.cb) !== payload.cb ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat > now + 30 ||
      payload.exp < now ||
      payload.exp - payload.iat !== DESKTOP_AUTH_TTL_SECONDS
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function verificarPkce(verifier: string, challenge: string) {
  const calculado = desafioPkce(verifier);
  if (!calculado || !validarDesafioPkce(challenge) || calculado.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(calculado), Buffer.from(challenge));
}
