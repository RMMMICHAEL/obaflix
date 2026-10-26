import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { COOKIE_VINCULO_GOOGLE, TTL_VINCULO_GOOGLE_SEG, criarIntencaoVinculo } from "@/lib/googleLink";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
const resposta = (corpo: Record<string, unknown>, status: number) => NextResponse.json(corpo, { status, headers: NO_STORE });

/**
 * `POST /api/auth/google-link` — o dono de uma conta COM SENHA confirma a senha atual e recebe, por 5 minutos, o direito
 * de vincular um Google a ela (cookie assinado, preso ao userId, de uso único). O vínculo em si só acontece no retorno do
 * Google (`callbacks.signIn`). Sem senha confirmada não há vínculo por igualdade de e-mail: fecha o pré-sequestro.
 */
export async function POST(req: NextRequest) {
  const origem = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  if (!origem || !headerMatchesHost(origem, host.split(",")[0].trim())) return resposta({ error: "Origem inválida" }, 403);

  const usuario = await getUserFromRequest(req);
  if (!usuario) return resposta({ error: "Não autenticado" }, 401);

  const limite = await checkRateLimit(`google-link:${usuario.userId}`, 5, 15 * 60);
  if (!limite.allowed) return resposta({ error: "Muitas tentativas" }, 429);

  let corpo: { senha?: unknown };
  try { corpo = await readJsonBody(req, 512); } catch { return resposta({ error: "Dados inválidos" }, 400); }
  if (typeof corpo?.senha !== "string" || corpo.senha.length === 0 || corpo.senha.length > 128) return resposta({ error: "Dados inválidos" }, 400);

  const conta = await prisma.user.findUnique({ where: { id: usuario.userId }, select: { senhaHash: true, googleSub: true } });
  if (!conta) return resposta({ error: "Não autenticado" }, 401);
  if (conta.googleSub) return resposta({ error: "Esta conta já tem um Google vinculado", codigo: "ja_vinculada" }, 409);
  if (!conta.senhaHash) return resposta({ error: "Esta conta não tem senha", codigo: "sem_senha" }, 400);
  if (!(await bcrypt.compare(corpo.senha, conta.senhaHash))) return resposta({ error: "Senha incorreta", codigo: "senha_incorreta" }, 401);

  const segredo = process.env.NEXTAUTH_SECRET ?? "";
  if (segredo.length < 32) return resposta({ error: "Indisponível" }, 503);

  const res = resposta({ ok: true }, 200);
  res.cookies.set(COOKIE_VINCULO_GOOGLE, criarIntencaoVinculo(usuario.userId, segredo), {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: TTL_VINCULO_GOOGLE_SEG,
  });
  return res;
}
