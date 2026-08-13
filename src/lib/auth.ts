import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { prisma } from "./prisma";
import { checkRateLimit } from "./requestSecurity";
import crypto from "crypto";

const DUMMY_PASSWORD_HASH = bcrypt.hash("not-a-valid-account-password", 10);

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
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: "/login" },
  cookies: {
    sessionToken: {
      name: "__Secure-next-auth.session-token",
      options: {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
      },
    },
    callbackUrl: {
      name: "__Secure-next-auth.callback-url",
      options: { httpOnly: true, secure: true, sameSite: "strict", path: "/" },
    },
    csrfToken: {
      name: "__Host-next-auth.csrf-token",
      options: { httpOnly: true, secure: true, sameSite: "strict", path: "/" },
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
    async jwt({ token, user }: any) {
      if (user) {
        token.id = user.id;
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
