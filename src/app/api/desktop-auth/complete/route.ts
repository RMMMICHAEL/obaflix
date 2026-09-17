import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  callbackDesktopSeguro,
  criarTicketDesktopAuth,
  validarDesafioPkce,
  validarEstadoDesktop,
} from "@/lib/desktopAuth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const challenge = url.searchParams.get("challenge");
  const state = url.searchParams.get("state");
  const rawCallback = url.searchParams.get("callbackUrl");
  const callbackUrl = callbackDesktopSeguro(rawCallback);

  if (
    !validarDesafioPkce(challenge) ||
    !validarEstadoDesktop(state) ||
    callbackUrl !== rawCallback
  ) {
    return new Response("Solicitação de login desktop inválida.", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    return new Response("Sessão Google não foi concluída. Volte ao aplicativo e tente novamente.", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32) {
    return new Response("Login desktop indisponível.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const ticket = criarTicketDesktopAuth({ userId, challenge, state, callbackUrl }, secret);
  const deepLink = new URL("obaflix://auth/callback");
  deepLink.searchParams.set("ticket", ticket);
  deepLink.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: deepLink.toString(),
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}
