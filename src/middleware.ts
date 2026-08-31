import { withAuth } from "next-auth/middleware";
import { NextResponse, type NextRequest } from "next/server";
import type { NextFetchEvent } from "next/server";
import { ehClienteNativo, ehPaginaFechada } from "@/config/site-mode";

const ADMIN_CORS_ORIGIN = "https://admin.megafrixapi.com";

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-token, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

const adminMiddleware = withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;
    const origin = req.headers.get("origin") ?? "";
    const isAdminApi = pathname.startsWith("/api/admin/");

    // Preflight CORS para rotas admin vindas do painel Megaflix
    if (req.method === "OPTIONS" && isAdminApi && origin === ADMIN_CORS_ORIGIN) {
      return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Requests com x-admin-token: não exige JWT — rota cuida da auth
    if (isAdminApi && req.headers.get("x-admin-token")) {
      const res = NextResponse.next();
      if (origin === ADMIN_CORS_ORIGIN) {
        Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.headers.set(k, v));
      }
      return res;
    }

    // Proteção JWT normal para /admin e /api/admin
    const role = (req.nextauth.token as { role?: string } | null)?.role;
    if (role !== "admin") {
      if (isAdminApi) {
        return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/", req.url));
    }

    const res = NextResponse.next();
    if (isAdminApi && origin === ADMIN_CORS_ORIGIN) {
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.headers.set(k, v));
    }
    return res;
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        // Preflight CORS: deixa passar, middleware retorna 204
        if (req.method === "OPTIONS") return true;
        // x-admin-token: rota valida internamente
        if (req.headers.get("x-admin-token")) return true;
        return !!token;
      },
    },
  }
);

/**
 * Porta de entrada única das páginas.
 *
 * Duas responsabilidades, nesta ordem:
 *   1. fechamento temporário da interface pública de streaming (ver
 *      `src/config/site-mode.ts`) — redireciona para a landing page;
 *   2. proteção do `/admin`, que continua sendo o `withAuth` de sempre.
 *
 * `/api/*` nunca chega aqui: está excluído do matcher. Nenhum endpoint usado
 * por Android, Android TV ou Electron é afetado por este arquivo.
 */
export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/admin")) {
    return (adminMiddleware as unknown as (
      r: NextRequest,
      e: NextFetchEvent,
    ) => ReturnType<typeof NextResponse.next>)(req, event);
  }

  // Clientes nativos passam direto: eles navegam pelas mesmas páginas dentro do
  // WebView/Electron e não podem cair na landing.
  if (ehPaginaFechada(pathname) && !ehClienteNativo(req.headers.get("user-agent"))) {
    const destino = new URL("/", req.url);
    return NextResponse.redirect(destino, 307);
  }

  return NextResponse.next();
}

export const config = {
  // /api/admin/* tem proteção própria via x-admin-token nos route handlers.
  // Tudo que é asset ou API fica de fora — o middleware só olha páginas.
  matcher: [
    "/((?!api|_next/static|_next/image|fonts|.*\.(?:png|jpe?g|gif|svg|webp|ico|avif|txt|xml|json|webmanifest|mp4|woff2?)$).*)",
  ],
};
