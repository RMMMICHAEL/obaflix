import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { prisma } from "./prisma";
import { checkRateLimit, clientIp } from "./requestSecurity";
import crypto from "crypto";
import { encode as encodeNextAuthJwt } from "next-auth/jwt";
import { canRoleSignInToSurface, getObaflixSurface, publicCutoverEnabled } from "@/config/obaflix-surface";
import { decodeVersionedSession, tokenAuthVersion } from "./authVersion";
import { newOpaque, validatedGoogleIdentity } from "./oauthGoogle";
import { findLinkedGoogleUser } from "./oauthGoogleStore";

const DUMMY_PASSWORD_HASH = bcrypt.hash("not-a-valid-account-password", 10);
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const USE_SECURE_COOKIES = process.env.NODE_ENV === "production" || process.env.NEXTAUTH_URL?.startsWith("https://") === true;
export const SESSION_COOKIE_NAME = `${USE_SECURE_COOKIES ? "__Secure-" : ""}next-auth.session-token`;

export const encodeObaflixSession = (params: Parameters<typeof encodeNextAuthJwt>[0]) => encodeNextAuthJwt(params);
export const decodeObaflixSession = decodeVersionedSession;

export const ADMIN_CORS_ORIGIN = "https://admin.megafrixapi.com";

/**
 * CORS só para o painel MegaFlix (origem do Tampermonkey legado) e só nas
 * rotas de catálogo legado. No painel separado nunca há CORS.
 */
export function withCors<T extends import("next/server").NextResponse>(res: T, req: import("next/server").NextRequest): T {
  if (getObaflixSurface() === "admin") return res;
  const origin = req.headers.get("origin");
  if (origin === ADMIN_CORS_ORIGIN) addCors(res, origin);
  return res;
}

function addCors(res: import("next/server").NextResponse, origin: string | null) {
  if (origin === ADMIN_CORS_ORIGIN) {
    res.headers.set("Access-Control-Allow-Origin", ADMIN_CORS_ORIGIN);
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
  }
  return res;
}

export type AdminSessionDeps = {
  loadSession?: () => Promise<{ user?: unknown } | null>;
  roleOf?: (userId: string) => Promise<string | null>;
};

/**
 * Guarda de toda API administrativa humana: sessão com `role=admin`
 * reconfirmado no banco. `x-admin-token` nunca autoriza aqui — se vier, é 403
 * sem sequer consultar a sessão, para ninguém confundir o token legado com
 * credencial de operador. `CATALOG_SYNC_TOKEN` também não serve (escopo
 * próprio em `/api/integracoes/catalogo/*`).
 *
 * Uso: `const guard = await requireAdmin(req); if (guard) return guard;`
 */
export async function requireAdmin(req: import("next/server").NextRequest, deps: AdminSessionDeps = {}) {
  return requireAdminSession(req, deps);
}

/** A requisição traz o header do token legado (em qualquer superfície)? */
export function isLegacyAdminTokenRequest(req: import("next/server").NextRequest): boolean {
  return !!req.headers.get("x-admin-token");
}

export async function requireAdminSession(req: import("next/server").NextRequest, deps: AdminSessionDeps = {}) {
  const { NextResponse } = await import("next/server");
  if (isLegacyAdminTokenRequest(req)) {
    return NextResponse.json({ error: "Sessão administrativa obrigatória" }, { status: 403 });
  }
  return requireAdminSessionOnly(null, deps);
}

/** Métodos que o token legado ainda pode usar nas rotas de catálogo. */
const LEGACY_CATALOG_METHODS = new Set(["GET", "POST"]);

/**
 * Transição do catálogo legado: `/api/admin/{filme,serie,episodio,episodio/bulk}`
 * aceitam, além da sessão admin, o `x-admin-token` (ADMIN_SECRET_TOKEN) do
 * Tampermonkey/sync-app antigos — e apenas enquanto TODAS valem:
 *   - superfície pública (no painel separado nunca);
 *   - cutover desligado (ligado, essas rotas já são 404 no público);
 *   - método GET ou POST (upsert/leitura; nunca PUT/DELETE);
 *   - ADMIN_SECRET_TOKEN configurado com ≥ 32 caracteres.
 * Para desligar antes do cutover basta remover ADMIN_SECRET_TOKEN do deploy.
 * O destino final desses produtores é `/api/integracoes/catalogo/*`.
 */
export async function requireAdminOrLegacyCatalogToken(req: import("next/server").NextRequest, deps: AdminSessionDeps = {}) {
  const { NextResponse } = await import("next/server");
  const origin = req.headers.get("origin");
  const legacyWindow = getObaflixSurface() === "public" && !publicCutoverEnabled();

  if (req.method === "OPTIONS") {
    const res = new NextResponse(null, { status: 204 });
    return legacyWindow ? addCors(res, origin) : res;
  }

  const supplied = req.headers.get("x-admin-token");
  if (!supplied) return requireAdminSessionOnly(null, deps);
  if (!legacyWindow || !LEGACY_CATALOG_METHODS.has(req.method)) {
    return addCors(NextResponse.json({ error: "Sessão administrativa obrigatória" }, { status: 403 }), legacyWindow ? origin : null);
  }

  const expected = process.env.ADMIN_SECRET_TOKEN ?? "";
  const rate = await checkRateLimit(`admin-token:${clientIp(req)}`, 30, 60);
  const valid = expected.length >= 32 && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (rate.allowed && valid) return null;
  return addCors(NextResponse.json({ error: "Token inválido" }, { status: 403 }), origin);
}

async function requireAdminSessionOnly(origin: string | null, deps: AdminSessionDeps = {}) {
  const { NextResponse } = await import("next/server");
  const loadSession = deps.loadSession ?? (() => getServerSession(authOptions));
  const roleOf = deps.roleOf ?? (async (id: string) =>
    (await prisma.user.findUnique({ where: { id }, select: { role: true } }))?.role ?? null);
  // O papel vem sempre do banco: o `role` do JWT pode estar desatualizado.
  const session = await loadSession();
  if (!session?.user) {
    return addCors(NextResponse.json({ error: "Não autenticado" }, { status: 401 }), origin);
  }
  const sessionUserId = (session.user as { id?: string }).id;
  const currentRole = sessionUserId ? await roleOf(sessionUserId) : null;
  if (currentRole !== "admin") {
    return addCors(NextResponse.json({ error: "Não autorizado" }, { status: 403 }), origin);
  }
  return null;
}

export const authOptions: NextAuthOptions = {
  debug: false,
  logger: {
    error() { console.error("AUTH_ERROR"); },
    warn() { console.warn("AUTH_WARNING"); },
    debug() {},
  },
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE },
  jwt: {
    maxAge: SESSION_MAX_AGE,
    encode: encodeObaflixSession,
    decode: decodeObaflixSession,
  },
  useSecureCookies: USE_SECURE_COOKIES,
  pages: { signIn: "/login" },
  cookies: {
    sessionToken: {
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        secure: USE_SECURE_COOKIES,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE,
      },
    },
    callbackUrl: {
      name: `${USE_SECURE_COOKIES ? "__Secure-" : ""}next-auth.callback-url`,
      options: { httpOnly: true, secure: USE_SECURE_COOKIES, sameSite: "lax", path: "/" },
    },
    csrfToken: {
      name: `${USE_SECURE_COOKIES ? "__Host-" : ""}next-auth.csrf-token`,
      options: { httpOnly: true, secure: USE_SECURE_COOKIES, sameSite: "lax", path: "/" },
    },
  },
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        senha: { label: "Senha", type: "password" },
      },
      async authorize(credentials: any, request: any) {
        try {
          if (typeof credentials?.email !== "string" || typeof credentials?.senha !== "string") return null;
          if (credentials.email.length > 254 || credentials.senha.length > 128) return null;
          const email = credentials.email.toLowerCase().trim();
          const forwarded = request?.headers?.["x-forwarded-for"];
          const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || "unknown";
          const [ipRate, accountRate] = await Promise.all([
            checkRateLimit(`login:ip:${ip}`, 40, 15 * 60),
            checkRateLimit(`login:account:${email}`, 12, 15 * 60),
          ]);
          if (!ipRate.allowed || !accountRate.allowed) return null;
          const user = await prisma.user.findUnique({ where: { email } });
          if (!user) {
            await bcrypt.compare(credentials.senha, await DUMMY_PASSWORD_HASH);
            return null;
          }
          if (!user.senhaHash) {
            // Contas sem senha precisam concluir recuperação legítima antes do vínculo.
            await bcrypt.compare(credentials.senha, await DUMMY_PASSWORD_HASH);
            return null;
          }
          const ok = await bcrypt.compare(credentials.senha, user.senhaHash);
          if (!ok) return null;
          if (!canRoleSignInToSurface(user.role, getObaflixSurface())) return null;
          return { id: user.id, email: user.email, name: user.nome, image: user.avatar, role: user.role, authVersion: user.authVersion };
        } catch {
          console.error("AUTH_ERROR");
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }: any) {
      if (account?.provider !== "google") return true;

      const identity = validatedGoogleIdentity(profile);
      let local;
      try { local = identity ? await findLinkedGoogleUser(identity) : null; }
      catch { console.error("AUTH_ERROR"); return "/login?error=GoogleLinkRequired"; }
      if (!local) return "/login?error=GoogleLinkRequired";
      if (!canRoleSignInToSurface(local.role, getObaflixSurface())) return false;

      user.id = local.id;
      user.email = local.email;
      user.name = local.nome;
      user.image = local.avatar;
      user.role = local.role;
      user.authVersion = local.authVersion;
      return true;
    },
    async jwt({ token, user, account }: any) {
      if (user) {
        token.id = user.id;
        token.sub = user.id;
        token.role = user.role ?? "user";
        token.email = user.email;
        token.name = user.name;
        token.picture = user.image;
        token.authVersion = user.authVersion;
        token.sid = newOpaque();
        token.authMethod = account?.provider;
      }
      // Client session.update payloads cannot change id, version or binding.
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        session.user.id = token.id;
        session.user.role = token.role;
        session.user.authVersion = tokenAuthVersion(token.authVersion);
      }
      return session;
    },
  },
};
