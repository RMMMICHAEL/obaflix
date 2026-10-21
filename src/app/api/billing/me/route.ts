import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { entitlementsDoUsuario } from "@/lib/entitlements";
import { prisma } from "@/lib/prisma";
import { nomePublicoDoPlano } from "@/lib/billing/vitrine";
import { ehPlanoCortes } from "@/lib/planos";
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
  // Até uma assinatura por família (tradicional e Cortes) pode estar vigente.
  // Sem direito ativo não há assinatura válida de família nenhuma: nada a consultar.
  const vigentes: { planoId: string; terminaEm: Date; plano: { nome: string; cortesNivel: string | null } }[] = !direitos.assinatura.ativa ? [] : await banco.assinatura.findMany({
    where: { userId: user.userId, status: "ATIVA", iniciaEm: { lte: agora() }, terminaEm: { gt: agora() } },
    select: { planoId: true, terminaEm: true, plano: { select: { nome: true, cortesNivel: true } } },
  });
  const assinatura = vigentes.find((a) => a.planoId === direitos.assinatura.planoId) ?? null;
  const cortes = vigentes.find((a) => ehPlanoCortes(a.plano.cortesNivel)) ?? null;
  const plano = await banco.plano.findUnique({ where: { id: direitos.assinatura.planoId }, select: { id: true, nome: true } });
  if (!plano) return NextResponse.json({ error: "Indisponível" }, { status: 503 });
  // Nome público da vitrine: a TV e a conta mostram "Básico", nunca "Basic".
  return NextResponse.json({
    plano: { id: plano.id, nome: nomePublicoDoPlano(plano.id, plano.nome) },
    assinatura: assinatura ? { status: "ATIVA", terminaEm: assinatura.terminaEm } : null,
    // Assinatura Cortes vigente, mesmo quando o plano base acima é o tradicional.
    cortes: cortes ? { plano: { id: cortes.planoId, nome: nomePublicoDoPlano(cortes.planoId, cortes.plano.nome) }, terminaEm: cortes.terminaEm } : null,
  }, { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = Object.assign(createBillingMeHandler(), { createForTest: createBillingMeHandler });
