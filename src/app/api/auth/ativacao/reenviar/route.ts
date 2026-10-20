export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp, readJsonBody } from "@/lib/requestSecurity";
import { emailDoComprador } from "@/lib/billing/pagador";
import { notificarPrimeiroAcesso } from "@/lib/primeiroAcesso";

type Deps = { prisma: typeof prisma; notificar: typeof notificarPrimeiroAcesso; limitar: typeof checkRateLimit };

/**
 * `POST /api/auth/ativacao/reenviar` — `{ email }`. Novo link para conta sem
 * senha (o anterior deixa de valer). A resposta é sempre a mesma: não revela se
 * o e-mail tem conta, nem se tem senha. Conta com senha não recebe nada.
 */
function criarHandlerDeReenvio(deps: Partial<Deps> = {}) {
  const banco = deps.prisma ?? prisma, notificar = deps.notificar ?? notificarPrimeiroAcesso, limitar = deps.limitar ?? checkRateLimit;
  return async function POST(req: NextRequest) {
    const pronto = NextResponse.json({ ok: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
    let corpo: { email?: unknown };
    try { corpo = await readJsonBody(req, 512); } catch { return pronto; }
    const email = emailDoComprador(corpo?.email);
    if (!email) return pronto;
    try {
      const [porIp, porEmail] = await Promise.all([
        limitar(`ativacao:reenvio:ip:${clientIp(req)}`, 5, 15 * 60),
        limitar(`ativacao:reenvio:email:${email}`, 3, 60 * 60),
      ]);
      if (!porIp.allowed || !porEmail.allowed) return pronto;
    } catch {
      return pronto;
    }
    const conta = await banco.user.findUnique({ where: { email }, select: { id: true, senhaHash: true } });
    if (conta && !conta.senhaHash) await notificar({ userId: conta.id, email, semSenha: true });
    return pronto;
  };
}

export const POST = Object.assign(criarHandlerDeReenvio(), { createForTest: criarHandlerDeReenvio });
