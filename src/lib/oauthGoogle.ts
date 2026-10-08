import crypto from "crypto";

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const LINK_TTL_SECONDS = 300;
export const LINK_COOKIE = process.env.NODE_ENV === "production" ? "__Host-obaflix-google-link" : "obaflix-google-link";
export const hashOpaque = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const newOpaque = () => crypto.randomBytes(32).toString("base64url");

export type GoogleIdentity = { issuer: typeof GOOGLE_ISSUER; subject: string };
/** Input is ONLY claims returned by the validated Google OIDC callback. */
export function validatedGoogleIdentity(profile: unknown): GoogleIdentity | null {
  if (!profile || typeof profile !== "object") return null;
  const claims = profile as Record<string, unknown>;
  if (claims.email_verified !== true) return null;
  if (claims.iss !== GOOGLE_ISSUER && claims.iss !== "accounts.google.com") return null;
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 || /\s/.test(claims.sub)) return null;
  return { issuer: GOOGLE_ISSUER, subject: claims.sub };
}

export type LinkActor = { userId: string; sid: string; authVersion: number; origin: string };
export type LinkIntent = {
  handleHash: string; userId: string; sessionBindingHash: string; authVersion: number;
  origin: string; reauthenticatedAt: Date; expiresAt: Date; consumedAt: Date | null;
};
export function makeLinkIntent(actor: LinkActor, now = new Date()) {
  const handle = newOpaque();
  const intent: LinkIntent = {
    handleHash: hashOpaque(handle), userId: actor.userId, sessionBindingHash: hashOpaque(actor.sid),
    authVersion: actor.authVersion, origin: actor.origin, reauthenticatedAt: now,
    expiresAt: new Date(now.getTime() + LINK_TTL_SECONDS * 1000), consumedAt: null,
  };
  return { handle, intent };
}
export function matchesLinkIntent(intent: LinkIntent, actor: LinkActor, handle: string, now = new Date()) {
  return /^[A-Za-z0-9_-]{43}$/.test(handle)
    && intent.handleHash === hashOpaque(handle)
    && intent.userId === actor.userId && intent.sessionBindingHash === hashOpaque(actor.sid)
    && intent.authVersion === actor.authVersion && intent.origin === actor.origin
    && intent.consumedAt === null && intent.expiresAt.getTime() > now.getTime()
    && intent.reauthenticatedAt.getTime() <= now.getTime()
    && intent.reauthenticatedAt.getTime() > now.getTime() - LINK_TTL_SECONDS * 1000;
}

export function validAccountMutation(input: {
  origin: string | null; requestOrigin: string; configuredOrigin: string;
  csrfToken: unknown; csrfCookie: string | undefined; secret: string | undefined;
}) {
  if (!input.secret || input.origin !== input.configuredOrigin || input.requestOrigin !== input.configuredOrigin) return false;
  if (typeof input.csrfToken !== "string" || !/^[a-f0-9]{64}$/.test(input.csrfToken)) return false;
  const [cookieToken, cookieHash] = (input.csrfCookie ?? "").split("|");
  if (cookieToken !== input.csrfToken || !/^[a-f0-9]{64}$/.test(cookieHash ?? "")) return false;
  const expected = hashOpaque(input.csrfToken + input.secret);
  return crypto.timingSafeEqual(Buffer.from(cookieHash), Buffer.from(expected));
}
