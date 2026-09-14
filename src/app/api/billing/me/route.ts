import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { nomePublicoDoPlano } from "@/lib/billing/vitrine";
export const dynamic = "force-dynamic";
function createBillingMeHandler(deps: any = {}) {
  const banco = deps.prisma ?? prisma;
  const usuario = deps.getUserFromRequest ?? getUserFromRequest;
  const entitlements = deps.entitlementsDoUsuario ?? entitlementsDoUsuario;
  const agora = deps.agora ?? (() => new Date());
  return async function GET(req: NextRequest) {
  const user = await usuario(req);
  if (!user) return NextResponse.json({ error: "Acesso negado" }, { status: 401 });
  const direitos = await entitlements(user.userId);
  const assinatura = direitos.assinatura.ativa ? await banco.assinatura.findFirst({
    where: { userId: user.userId, status: "ATIVA", iniciaEm: { lte: agora() }, terminaEm: { gt: agora() } },
    select: { terminaEm: true },
  }) : null;
  const plano = await banco.plano.findUnique({ where: { id: direitos.assinatura.planoId }, select: { id: true, nome: true } });
  if (!plano) return NextResponse.json({ error: "Indisponível" }, { status: 503 });
  // Nome público da vitrine: a TV e a conta mostram "Básico", nunca "Basic".
  return NextResponse.json({ plano: { id: plano.id, nome: nomePublicoDoPlano(plano.id, plano.nome) }, assinatura: assinatura ? { status: "ATIVA", terminaEm: assinatura.terminaEm } : null }, { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = Object.assign(createBillingMeHandler(), { createForTest: createBillingMeHandler });
