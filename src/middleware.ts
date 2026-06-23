import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

// Protege /admin e /api/admin: exige sessão JWT com role "admin".
export default withAuth(
  function middleware(req) {
    const role = (req.nextauth.token as { role?: string } | null)?.role;
    if (role !== "admin") {
      const isApi = req.nextUrl.pathname.startsWith("/api/");
      if (isApi) {
        return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  },
  {
    callbacks: {
      // Garante que o token exista; a checagem de role acontece acima.
      authorized: ({ token }) => !!token,
    },
  }
);

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
