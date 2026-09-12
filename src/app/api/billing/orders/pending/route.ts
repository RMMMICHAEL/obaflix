import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
export const dynamic = "force-dynamic";

/** Recuperação de checkout somente para o dono; nunca revela transactionId. */
function createPendingOrderHandler(deps: any = {}) {
  const banco = deps.prisma ?? prisma;
  const usuario = deps.getUserFromRequest ?? getUserFromRequest;
  const agora = deps.agora ?? (() => new Date());
  return async function GET(req: NextRequest) {
  const user = await usuario(req);
  if (!user) return NextResponse.json({ error: "Acesso negado" }, { status: 401 });
  const pedido = await banco.pedidoPagamento.findFirst({
    where: { userId: user.userId, status: "AGUARDANDO", expiraEm: { gt: agora() } },
    orderBy: { criadoEm: "desc" },
    select: { id: true, status: true, valorCentavos: true, moeda: true, expiraEm: true },
  });
  return NextResponse.json({ pedido: pedido && { pedidoId: pedido.id, status: pedido.status, valorCentavos: pedido.valorCentavos, moeda: pedido.moeda, expiraEm: pedido.expiraEm } }, { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = Object.assign(createPendingOrderHandler(), { createForTest: createPendingOrderHandler });
