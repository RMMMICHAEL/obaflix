import { NextRequest, NextResponse } from "next/server";
import { getObaflixSurface } from "@/config/obaflix-surface";
import { repoUsuariosPrisma } from "@/lib/auth";
import { criarTicketDesktopAuth, validarDesafioPkce, validarEstadoDesktop } from "@/lib/desktopAuth";
import { chavesGoogle, verificarIdTokenGoogle } from "@/lib/googleIdToken";
import { registrarAceiteGoogle, registrarRecusaGoogle, resolverContaGoogle } from "@/lib/googleSignIn";
import { checkRateLimit, clientIp, readJsonBody } from "@/lib/requestSecurity";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
const resposta = (corpo: Record<string, unknown>, status: number) => NextResponse.json(corpo, { status, headers: NO_STORE });

/**
 * `POST /api/desktop-auth/google-native` — login Google nativo do Android (Credential Manager). O app envia o ID token, o
 * desafio PKCE e o state; o servidor valida o token (assinatura do Google, emissor, público, validade e `nonce` = desafio),
 * resolve a conta pelas MESMAS regras do login pelo navegador (`resolverContaGoogle`, sem vínculo automático por e-mail a
 * conta com senha) e devolve um ticket do handoff existente, que o app troca por sessão em `/exchange` com o verifier.
 */
export async function POST(req: NextRequest) {
  const limite = await checkRateLimit(`google-native:${clientIp(req)}`, 20, 15 * 60);
  if (!limite.allowed) return resposta({ error: "Muitas tentativas" }, 429);

  let corpo: { idToken?: unknown; challenge?: unknown; state?: unknown };
  try { corpo = await readJsonBody(req, 8 * 1024); } catch { return resposta({ error: "Dados inválidos" }, 400); }
  const { idToken, challenge, state } = corpo ?? {};
  if (typeof idToken !== "string" || !/^[\w-]{10,3000}\.[\w-]{10,3000}\.[\w-]{10,1000}$/.test(idToken)
    || !validarDesafioPkce(challenge as string) || !validarEstadoDesktop(state as string)) {
    return resposta({ error: "Dados inválidos" }, 400);
  }

  const segredo = process.env.NEXTAUTH_SECRET ?? "";
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  if (segredo.length < 32 || !clientId) return resposta({ error: "Indisponível" }, 503);

  const perfil = await verificarIdTokenGoogle(idToken, { audiencias: [clientId], nonce: challenge as string, chaves: chavesGoogle });
  if (!perfil) return resposta({ error: "Token Google inválido", codigo: "token_invalido" }, 401);

  const resultado = await resolverContaGoogle(repoUsuariosPrisma, perfil, getObaflixSurface(), { vinculoAutorizadoPara: null });
  if (!resultado.ok) {
    registrarRecusaGoogle(resultado.motivo);
    return resposta({ error: "Login com Google não permitido", codigo: resultado.motivo }, 403);
  }
  registrarAceiteGoogle(resultado.acao);

  const ticket = criarTicketDesktopAuth(
    { userId: resultado.usuario.id, challenge: challenge as string, state: state as string, callbackUrl: "/desktop" },
    segredo,
  );
  return resposta({ ticket }, 200);
}
