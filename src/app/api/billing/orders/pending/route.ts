import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { MENSAGEM_DE_REVISAO_AO_COMPRADOR } from "@/lib/billing/revisao";
export const dynamic = "force-dynamic";

/**
 * Recuperação de checkout somente para o dono; nunca revela transactionId.
 *
 * Pagamento em revisão vem primeiro e continua aparecendo depois de recarregar,
 * sair e entrar de novo: é o que impede a pessoa de achar que nada aconteceu e
 * pagar outra vez.
 */
function createPendingOrderHandler(deps: any = {}) {
  const banco = deps.prisma ?? prisma;
  const usuario = deps.getUserFromRequest ?? getUserFromRequest;
  const agora = deps.agora ?? (() => new Date());
  return async function GET(req: NextRequest) {
  const user = await usuario(req);
  if (!user) return NextResponse.json({ error: "Acesso negado" }, { status: 401 });

  const caso = await banco.revisaoPagamento.findFirst({
    where: { userId: user.userId, status: "PENDENTE" },
    orderBy: { abertaEm: "desc" },
    select: { pedido: { select: { id: true, status: true, valorCentavos: true, moeda: true, expiraEm: true } } },
  });
  if (caso?.pedido) {
    const p = caso.pedido;
    return NextResponse.json(
      { pedido: { pedidoId: p.id, status: p.status, valorCentavos: p.valorCentavos, moeda: p.moeda, expiraEm: p.expiraEm, emRevisao: true, mensagem: MENSAGEM_DE_REVISAO_AO_COMPRADOR } },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const pedido = await banco.pedidoPagamento.findFirst({
    where: { userId: user.userId, status: "AGUARDANDO", expiraEm: { gt: agora() } },
    orderBy: { criadoEm: "desc" },
    select: { id: true, status: true, valorCentavos: true, moeda: true, expiraEm: true },
  });
  return NextResponse.json({ pedido: pedido && { pedidoId: pedido.id, status: pedido.status, valorCentavos: pedido.valorCentavos, moeda: pedido.moeda, expiraEm: pedido.expiraEm, emRevisao: false } }, { headers: { "Cache-Control": "no-store" } });
  };
}

export const GET = Object.assign(createPendingOrderHandler(), { createForTest: createPendingOrderHandler });
