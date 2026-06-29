import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { prisma } from "./prisma";

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
  if (req?.headers.get("x-admin-token")) {
    if (req.headers.get("x-admin-token") === process.env.ADMIN_SECRET_TOKEN) {
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
  if ((session.user as { role?: string }).role !== "admin") {
    return addCors(NextResponse.json({ error: "Não autorizado" }, { status: 403 }), origin);
  }
  return null;
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
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
      async authorize(credentials: any) {
        if (!credentials?.email || !credentials?.senha) return null;
        const user = await prisma.user.findUnique({ where: { email: credentials.email.toLowerCase().trim() } });
        if (!user) return null;
        if (!user.senhaHash) {
          // Conta criada via Google — não tem senha, retorna erro específico
          throw new Error("google-account");
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
