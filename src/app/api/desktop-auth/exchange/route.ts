import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  USE_SECURE_COOKIES,
  encodeObaflixSession,
} from "@/lib/auth";
import { verificarPkce, verificarTicketDesktopAuth } from "@/lib/desktopAuth";

export const dynamic = "force-dynamic";

function resposta(texto: string, status: number) {
  return new Response(texto, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}

export async function POST(request: Request) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32) return resposta("indisponivel", 503);

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return resposta("formato_invalido", 415);
  }

  const form = await request.formData();
  const ticket = form.get("ticket");
  const verifier = form.get("verifier");
  if (typeof ticket !== "string" || typeof verifier !== "string") return resposta("dados_invalidos", 400);

  const payload = verificarTicketDesktopAuth(ticket, secret);
  if (!payload || !verificarPkce(verifier, payload.ch)) return resposta("handoff_invalido", 401);

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, nome: true, avatar: true, role: true },
  });
  if (!user) return resposta("usuario_invalido", 401);

  const sessionToken = await encodeObaflixSession({
    secret,
    maxAge: SESSION_MAX_AGE,
    token: {
      id: user.id,
      sub: user.id,
      email: user.email,
      name: user.nome,
      picture: user.avatar,
      role: user.role,
    },
  });

  const expires = new Date(Date.now() + SESSION_MAX_AGE * 1000);
  const body = "<!doctype html><meta charset=\"utf-8\"><body data-obaflix-desktop-auth=\"ok\">OK</body>";
  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });

  response.headers.append(
    "Set-Cookie",
    [
      `${SESSION_COOKIE_NAME}=${sessionToken}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      USE_SECURE_COOKIES ? "Secure" : "",
      `Expires=${expires.toUTCString()}`,
      `Max-Age=${SESSION_MAX_AGE}`,
    ].filter(Boolean).join("; "),
  );

  return response;
}
