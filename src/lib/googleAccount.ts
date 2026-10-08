import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { decodeVersionedSession, tokenAuthVersion } from "./authVersion";
import { prisma } from "./prisma";
import { checkRateLimit, clientIp, readJsonBody } from "./requestSecurity";
import { GOOGLE_ISSUER, LINK_COOKIE, LINK_TTL_SECONDS, LinkActor, makeLinkIntent, validAccountMutation } from "./oauthGoogle";
import { revokeGoogleLink, saveLinkIntent } from "./oauthGoogleStore";
import { canRoleSignInToSurface, getObaflixSurface } from "@/config/obaflix-surface";

const secureCookies = () => process.env.NODE_ENV === "production" || process.env.NEXTAUTH_URL?.startsWith("https://") === true;
export const linkCookieOptions = () => ({ httpOnly: true, secure: secureCookies(), sameSite: "lax" as const, path: "/", maxAge: LINK_TTL_SECONDS });
export function configuredAuthOrigin() {
  try { return new URL(process.env.NEXTAUTH_URL ?? "").origin; } catch { return null; }
}
export function accountResponse(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function accountActor(req: NextRequest): Promise<LinkActor | null> {
  const origin = configuredAuthOrigin();
  if (!origin || req.nextUrl.origin !== origin) return null;
  // Management requires an embedded cookie session, never an Authorization JWT.
  const headers = new Headers(req.headers);
  headers.delete("authorization");
  const token = await getToken({
    req: new NextRequest(req.url, { headers }),
    secret: process.env.NEXTAUTH_SECRET, secureCookie: secureCookies(), decode: decodeVersionedSession,
  });
  if (!token || typeof token.id !== "string" || typeof token.sid !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token.sid)) return null;
  const authVersion = tokenAuthVersion(token.authVersion);
  if (authVersion === null) return null;
  return { userId: token.id, sid: token.sid, authVersion, origin };
}

export async function googleAccountState(req: NextRequest) {
  try {
    const actor = await accountActor(req);
    if (!actor) return accountResponse({ error: "Entre novamente com email e senha." }, 401);
    const linked = await prisma.oAuthIdentity.count({ where: { userId: actor.userId, issuer: GOOGLE_ISSUER, revokedAt: null } });
    return accountResponse({ linked: linked > 0 });
  } catch { return accountResponse({ error: "Não foi possível verificar o vínculo." }, 503); }
}

export async function googleAccountMutation(req: NextRequest, operation: "link" | "unlink") {
  try {
    const actor = await accountActor(req);
    if (!actor) return accountResponse({ error: "Entre novamente com email e senha." }, 401);
    const body = await readJsonBody<{ senha?: unknown; csrfToken?: unknown }>(req, 2048);
    const csrfCookie = req.cookies.get(secureCookies() ? "__Host-next-auth.csrf-token" : "next-auth.csrf-token")?.value;
    if (!validAccountMutation({
      origin: req.headers.get("origin"), requestOrigin: req.nextUrl.origin, configuredOrigin: actor.origin,
      csrfToken: body.csrfToken, csrfCookie, secret: process.env.NEXTAUTH_SECRET,
    })) return accountResponse({ error: "Solicitação inválida." }, 403);
    const [accountRate, ipRate] = await Promise.all([
      checkRateLimit(`google-account:${actor.userId}`, 5, 900),
      checkRateLimit(`google-account-ip:${clientIp(req)}`, 20, 900),
    ]);
    if (!accountRate.allowed || !ipRate.allowed) return accountResponse({ error: "Aguarde antes de tentar novamente." }, 429);
    const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { senhaHash: true, authVersion: true, role: true } });
    if (!user?.senhaHash || user.authVersion !== actor.authVersion || !canRoleSignInToSurface(user.role, getObaflixSurface())
      || typeof body.senha !== "string" || body.senha.length > 128 || !await bcrypt.compare(body.senha, user.senhaHash)) {
      return accountResponse({ error: "Não foi possível confirmar a conta." }, 403);
    }
    if (operation === "link") {
      const { handle, intent } = makeLinkIntent(actor);
      await saveLinkIntent(intent);
      const response = accountResponse({ ok: true });
      response.cookies.set(LINK_COOKIE, handle, linkCookieOptions());
      return response;
    }
    await revokeGoogleLink(actor, user.senhaHash);
    const response = accountResponse({ ok: true });
    response.cookies.set(LINK_COOKIE, "", { ...linkCookieOptions(), maxAge: 0 });
    // Clear all chunks as well as the unchunked cookie. Server version checks
    // invalidate every other browser session without rotating NEXTAUTH_SECRET.
    const sessionCookie = secureCookies() ? "__Secure-next-auth.session-token" : "next-auth.session-token";
    for (const cookie of req.cookies.getAll()) {
      if (cookie.name === sessionCookie || cookie.name.startsWith(sessionCookie + ".")) {
        response.cookies.set(cookie.name, "", { ...linkCookieOptions(), maxAge: 0 });
      }
    }
    return response;
  } catch {
    return accountResponse({ error: "Não foi possível concluir a solicitação." }, 400);
  }
}
