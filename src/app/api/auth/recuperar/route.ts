export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp, readJsonBody } from "@/lib/requestSecurity";
import { emailDoComprador } from "@/lib/billing/pagador";
import { enviarRecuperacaoDeSenha } from "@/lib/recuperarSenha";

type Deps = { prisma: typeof prisma; enviar: typeof enviarRecuperacaoDeSenha; limitar: typeof checkRateLimit };

/**
 * `POST /api/auth/recuperar` — `{ email }`. Envia o link de redefinição de senha. A resposta é sempre a mesma (202):
 * não revela se o e-mail tem conta. Limite por IP e por e-mail.
 */
function criarHandlerDeRecuperacao(deps: Partial<Deps> = {}) {
  const banco = deps.prisma ?? prisma, enviar = deps.enviar ?? enviarRecuperacaoDeSenha, limitar = deps.limitar ?? checkRateLimit;
  return async function POST(req: NextRequest) {
    const pronto = NextResponse.json({ ok: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
    let corpo: { email?: unknown };
    try { corpo = await readJsonBody(req, 512); } catch { return pronto; }
    const email = emailDoComprador(corpo?.email);
    if (!email) return pronto;
    try {
      const [porIp, porEmail] = await Promise.all([
        limitar(`recuperar:ip:${clientIp(req)}`, 5, 15 * 60),
        limitar(`recuperar:email:${email}`, 3, 60 * 60),
      ]);
      if (!porIp.allowed || !porEmail.allowed) return pronto;
    } catch {
      return pronto;
    }
    const conta = await banco.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (conta) await enviar({ userId: conta.id, email: conta.email });
    return pronto;
  };
}

export const POST = Object.assign(criarHandlerDeRecuperacao(), { createForTest: criarHandlerDeRecuperacao });
