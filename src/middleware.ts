import { withAuth } from "next-auth/middleware";
import { NextResponse, type NextRequest } from "next/server";
import type { NextFetchEvent } from "next/server";
import { decidirRota, detectarAmbiente, HEADER_CLIENTE } from "@/config/site-mode";
import { decideSurfaceGate, getObaflixSurface, publicCutoverEnabled } from "@/config/obaflix-surface";

/**
 * Só páginas `/admin*` chegam aqui (as APIs saem antes, e a autorização delas
 * fica nos route handlers). Página administrativa exige JWT com `role=admin`;
 * nenhum cabeçalho (`x-admin-token` incluído) substitui a sessão. O papel é
 * reconfirmado no banco por cada API que a página chama.
 */
const adminMiddleware = withAuth(
  function middleware(req) {
    const role = (req.nextauth.token as { role?: string } | null)?.role;
    if (role !== "admin") {
      // Na superfície admin, `/` volta para `/admin`: mandar para lá seria laço.
      const destino = getObaflixSurface() === "admin" ? "/login" : "/";
      return NextResponse.redirect(new URL(destino, req.url));
    }
    return NextResponse.next();
  },
  {
    callbacks: { authorized: ({ token }) => !!token },
    // Painel separado usa a própria tela de login; o público mantém o padrão.
    ...(getObaflixSurface() === "admin" ? { pages: { signIn: "/login" } } : {}),
  }
);

/**
 * Porta de entrada única das páginas.
 *
 * Duas responsabilidades, nesta ordem:
 *   1. separar navegador comum dos ambientes dos aplicativos, entregando a
 *      cada um a sua entrada. A regra inteira vive em `src/config/site-mode.ts`
 *      — aqui só se executa o que ela decide, para não existir uma segunda
 *      versão da política escondida neste arquivo;
 *   2. proteção do `/admin`, que continua sendo o `withAuth` de sempre.
 *
 * `/api/*` nunca chega aqui: está excluído do matcher. Nenhum endpoint usado
 * por Android, Android TV ou Electron passa por este arquivo.
 */
export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;

  const gate = decideSurfaceGate(pathname, getObaflixSurface(), publicCutoverEnabled());
  if (gate === "nao_encontrado") {
    return pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Não encontrado" }, { status: 404 })
      : new NextResponse("Não encontrado", { status: 404 });
  }
  if (gate === "painel") return NextResponse.redirect(new URL("/admin", req.url), 307);

  // `/api/admin/*` só entra no matcher por causa do gate acima (cutover). A
  // autorização continua nos route handlers, como sempre foi.
  if (pathname.startsWith("/api/")) return NextResponse.next();

  if (pathname.startsWith("/admin")) {
    return (adminMiddleware as unknown as (
      r: NextRequest,
      e: NextFetchEvent,
    ) => ReturnType<typeof NextResponse.next>)(req, event);
  }

  const ambiente = detectarAmbiente(
    req.headers.get("user-agent"),
    req.headers.get(HEADER_CLIENTE),
  );
  const decisao = decidirRota(pathname, ambiente);

  if (decisao.tipo === "landing") {
    return NextResponse.redirect(new URL("/", req.url), 307);
  }

  if (decisao.tipo === "reescreve") {
    // Reescrita, não redirect: a URL continua `/` no aplicativo. Versões já
    // instaladas do Android e do Electron abrem a raiz e recebem a interface
    // certa sem precisar atualizar.
    const destino = req.nextUrl.clone();
    destino.pathname = decisao.para;
    return NextResponse.rewrite(destino);
  }

  return NextResponse.next();
}

export const config = {
  // Páginas, como antes. De `/api/*` só entra `/api/admin/*`, e apenas para o
  // gate de superfície/cutover: incluir todo `/api` cobraria uma invocação de
  // middleware por requisição do player e dos apps. As demais APIs na
  // superfície admin são bloqueadas no build (rewrites em next.config.mjs).
  matcher: [
    "/((?!api|_next/static|_next/image|fonts|.*\.(?:png|jpe?g|gif|svg|webp|ico|avif|txt|xml|json|webmanifest|mp4|woff2?)$).*)",
    "/api/admin/:path*",
  ],
};
