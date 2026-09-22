import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { prisma } from "./prisma";
import { checkRateLimit } from "./requestSecurity";
import crypto from "crypto";
import { encode as encodeNextAuthJwt, decode as decodeNextAuthJwt } from "next-auth/jwt";

const DUMMY_PASSWORD_HASH = bcrypt.hash("not-a-valid-account-password", 10);
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
export const USE_SECURE_COOKIES = process.env.NODE_ENV === "production" || process.env.NEXTAUTH_URL?.startsWith("https://") === true;
export const SESSION_COOKIE_NAME = `${USE_SECURE_COOKIES ? "__Secure-" : ""}next-auth.session-token`;

export const encodeObaflixSession = (params: Parameters<typeof encodeNextAuthJwt>[0]) => encodeNextAuthJwt(params);
export const decodeObaflixSession = (params: Parameters<typeof decodeNextAuthJwt>[0]) => decodeNextAuthJwt(params);

/**
 * Autoriza apenas usuários autenticados com role "admin".
 * Lança NextResponse 401/403 que deve ser propagado pela rota.
 * Uso:  const guard = await requireAdmin(); if (guard) return guard;
 */
export const ADMIN_CORS_ORIGIN = "https://admin.megafrixapi.com";

export function withCors<T extends import("next/server").NextResponse>(res: T, req: import("next/server").NextRequest): T {
  const origin = req.headers.get("origin");
  if (origin === ADMIN_CORS_ORIGIN) addCors(res, origin);
  return res;
}

function addCors(res: import("next/server").NextResponse, origin: string | null) {
  if (origin === ADMIN_CORS_ORIGIN) {
    res.headers.set("Access-Control-Allow-Origin", ADMIN_CORS_ORIGIN);
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
  }
  return res;
}

export async function requireAdmin(req?: import("next/server").NextRequest) {
  const { NextResponse } = await import("next/server");
  const origin = req?.headers.get("origin") ?? null;

  // Preflight
  if (req?.method === "OPTIONS") {
    return addCors(new NextResponse(null, { status: 204 }), origin);
  }

  // Token direto (console script do painel Megaflix)
  const suppliedAdminToken = req?.headers.get("x-admin-token");
  if (suppliedAdminToken) {
    const expectedAdminToken = process.env.ADMIN_SECRET_TOKEN ?? "";
    const forwarded = req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const rate = await checkRateLimit(`admin-token:${forwarded}`, 30, 60);
    const validLength = expectedAdminToken.length >= 32 && suppliedAdminToken.length === expectedAdminToken.length;
    const validToken = validLength && crypto.timingSafeEqual(
      Buffer.from(suppliedAdminToken), Buffer.from(expectedAdminToken)
    );
    if (rate.allowed && validToken) {
      return null; // autorizado
    }
    return addCors(
      NextResponse.json({ error: "Token inválido" }, { status: 403 }),
      origin
    );
  }

  // JWT session (painel /admin)
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return addCors(NextResponse.json({ error: "Não autenticado" }, { status: 401 }), origin);
  }
  const sessionUserId = (session.user as { id?: string }).id;
  const currentUser = sessionUserId
    ? await prisma.user.findUnique({ where: { id: sessionUserId }, select: { role: true } })
    : null;
  if (currentUser?.role !== "admin") {
    return addCors(NextResponse.json({ error: "Não autorizado" }, { status: 403 }), origin);
  }
  return null;
}

export const authOptions: NextAuthOptions = {
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
          // Conta criada via Google — não tem senha, retorna erro específico
          await bcrypt.compare(credentials.senha, await DUMMY_PASSWORD_HASH);
          return null;
        }
        const ok = await bcrypt.compare(credentials.senha, user.senhaHash);
        if (!ok) return null;
        return { id: user.id, email: user.email, name: user.nome, role: user.role };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }: any) {
      if (account?.provider !== "google") return true;

      const email = typeof user?.email === "string"
        ? user.email.normalize("NFKC").toLowerCase().trim()
        : "";
      if (!email || profile?.email_verified !== true) return false;

      // Sem adapter OAuth, o id que o Google entrega nao e User.id. O Obaflix
      // vincula apenas a uma conta que ja existe; login nunca cria ou altera linha.
      const local = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, nome: true, avatar: true, role: true },
      });
      if (!local) return false;

      user.id = local.id;
      user.email = local.email;
      user.name = local.nome;
      user.image = local.avatar;
      user.role = local.role;
      return true;
    },
    async jwt({ token, user, account }: any) {
      if (account?.provider === "google" && typeof token.email === "string") {
        const email = token.email.normalize("NFKC").toLowerCase().trim();
        const local = await prisma.user.findUnique({
          where: { email },
          select: { id: true, nome: true, avatar: true, role: true },
        });
        if (local) {
          token.id = local.id;
          token.sub = local.id;
          token.role = local.role;
          token.name = local.nome;
          token.picture = local.avatar;
        }
      } else if (user) {
        token.id = user.id;
        token.sub = user.id;
        token.role = user.role ?? "user";
      }
      return token;
    },
    async session({ session, token }: any) {
      if (session.user) {
        session.user.id = token.id;
        session.user.role = token.role;
      }
      return session;
    },
  },
};
