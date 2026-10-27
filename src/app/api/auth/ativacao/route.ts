export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/auditLog";
import { checkRateLimit, clientIp, readJsonBody } from "@/lib/requestSecurity";
import { consumirTokenDeAtivacao, senhaValida } from "@/lib/primeiroAcesso";

const SEM_CACHE = { "Cache-Control": "no-store" };
const resposta = (status: number, corpo: object) => NextResponse.json(corpo, { status, headers: SEM_CACHE });
const LINK_INVALIDO = () => resposta(400, { error: "Link inválido ou expirado. Peça um novo." });

type Deps = { prisma: typeof prisma; consumir: typeof consumirTokenDeAtivacao; limitar: typeof checkRateLimit };

/**
 * `POST /api/auth/ativacao` — `{ token, senha }`. Cria a senha de uma conta que
 * ainda não tem, com o link de uso único do e-mail da compra.
 *
 * A senha é validada e o hash calculado **antes** de consumir o link: senha
 * fraca não queima o link. Conta que já tem senha nunca é alterada aqui.
 */
function criarHandlerDeAtivacao(deps: Partial<Deps> = {}) {
  const banco = deps.prisma ?? prisma, consumir = deps.consumir ?? consumirTokenDeAtivacao, limitar = deps.limitar ?? checkRateLimit;
  return async function POST(req: NextRequest) {
    const ip = clientIp(req);
    try {
      if (!(await limitar(`ativacao:ip:${ip}`, 10, 15 * 60)).allowed) return resposta(429, { error: "Muitas tentativas. Tente mais tarde." });
    } catch {
      return resposta(503, { error: "Indisponível. Tente mais tarde." });
    }
    let corpo: { token?: unknown; senha?: unknown };
    try { corpo = await readJsonBody(req, 1024); } catch { return LINK_INVALIDO(); }
    if (!senhaValida(corpo?.senha)) return resposta(400, { error: "A senha deve ter entre 8 e 128 caracteres, com letras e números." });
    const senhaHash = await bcrypt.hash(corpo.senha, 10);

    const userId = await consumir(corpo.token);
    if (!userId) {
      audit("account_activation_rejected", { ip, detail: "link invalido" });
      return LINK_INVALIDO();
    }
    // Condicional no banco: só grava se a conta ainda não tem senha.
    const r = await banco.user.updateMany({ where: { id: userId, senhaHash: null }, data: { senhaHash } });
    if (r.count !== 1) {
      audit("account_activation_rejected", { userId, ip, detail: "conta ja tem senha" });
      return LINK_INVALIDO();
    }
    audit("account_activated", { userId, ip });
    return resposta(200, { ok: true });
  };
}

export const POST = Object.assign(criarHandlerDeAtivacao(), { createForTest: criarHandlerDeAtivacao });
