export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/auditLog";
import { checkRateLimit, clientIp, readJsonBody } from "@/lib/requestSecurity";
import { consumirTokenDeAtivacao, senhaValida } from "@/lib/primeiroAcesso";
import { revogarSessoesAposTrocaDeSenha } from "@/lib/sessionRevocation";

const SEM_CACHE = { "Cache-Control": "no-store" };
const resposta = (status: number, corpo: object) => NextResponse.json(corpo, { status, headers: SEM_CACHE });
const LINK_INVALIDO = () => resposta(400, { error: "Link inválido ou expirado. Peça um novo." });

type Deps = { prisma: typeof prisma; consumir: typeof consumirTokenDeAtivacao; limitar: typeof checkRateLimit; revogar: typeof revogarSessoesAposTrocaDeSenha };

/**
 * `POST /api/auth/redefinir` — `{ token, senha }`. Troca a senha da conta dona do link de uso único enviado por e-mail.
 * A senha é validada e o hash calculado ANTES de consumir o link: senha fraca não queima o link.
 */
function criarHandlerDeRedefinicao(deps: Partial<Deps> = {}) {
  const banco = deps.prisma ?? prisma, consumir = deps.consumir ?? consumirTokenDeAtivacao, limitar = deps.limitar ?? checkRateLimit, revogar = deps.revogar ?? revogarSessoesAposTrocaDeSenha;
  return async function POST(req: NextRequest) {
    const ip = clientIp(req);
    try {
      if (!(await limitar(`redefinir:ip:${ip}`, 10, 15 * 60)).allowed) return resposta(429, { error: "Muitas tentativas. Tente mais tarde." });
    } catch {
      return resposta(503, { error: "Indisponível. Tente mais tarde." });
    }
    let corpo: { token?: unknown; senha?: unknown };
    try { corpo = await readJsonBody(req, 1024); } catch { return LINK_INVALIDO(); }
    if (!senhaValida(corpo?.senha)) return resposta(400, { error: "A senha deve ter entre 8 e 128 caracteres, com letras e números." });
    const senhaHash = await bcrypt.hash(corpo.senha, 10);

    const userId = await consumir(corpo.token);
    if (!userId) {
      audit("password_reset_rejected", { ip, detail: "link invalido" });
      return LINK_INVALIDO();
    }
    // Antes de trocar a senha: se não der para encerrar as sessões antigas, a senha continua a mesma (o link já foi usado: pedir outro).
    try {
      await revogar(userId);
    } catch {
      return resposta(503, { error: "Indisponível. Peça um novo link e tente de novo." });
    }
    const r = await banco.user.updateMany({ where: { id: userId }, data: { senhaHash } });
    if (r.count !== 1) {
      audit("password_reset_rejected", { userId, ip, detail: "conta inexistente" });
      return LINK_INVALIDO();
    }
    audit("password_reset", { userId, ip });
    return resposta(200, { ok: true });
  };
}

export const POST = Object.assign(criarHandlerDeRedefinicao(), { createForTest: criarHandlerDeRedefinicao });
