import { withAuth } from "next-auth/middleware";
import { NextResponse, type NextRequest } from "next/server";

const ADMIN_CORS_ORIGIN = "https://admin.megafrixapi.com";

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-token, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export default withAuth(
  function middleware(req: NextRequest) {
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
        // Permite passar se tiver x-admin-token (rota valida internamente)
        if (req.headers.get("x-admin-token")) return true;
        return !!token;
      },
    },
  }
);

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
