import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/requestSecurity";
import { confirmarPedidoPorId } from "@/lib/billing/confirmacao";
export const dynamic = "force-dynamic";

function createGetPedidoHandler(deps:any={}) { const banco=deps.prisma??prisma, usuario=deps.getUserFromRequest??getUserFromRequest, limitar=deps.checkRateLimit??checkRateLimit, confirmar=deps.confirmarPedidoPorId??confirmarPedidoPorId, flag=deps.confirmacaoAtiva??(()=>process.env.BLACKCAT_CONFIRMACAO_ATIVA==="true"); return async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await usuario(req); if (!user) return NextResponse.json({ error: "Acesso negado" }, { status: 401 });
  const pedido = await banco.pedidoPagamento.findFirst({ where: { id: params.id, userId: user.userId }, select: { id:true,status:true,valorCentavos:true,moeda:true,expiraEm:true,transacaoId:true } });
  if (!pedido) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });
  if (flag() && pedido.status === "AGUARDANDO" && pedido.transacaoId) {
    try { const limite=await limitar(`billing:poll:${user.userId}:${pedido.id}`, 6, 60); if(limite.allowed) await confirmar(pedido.id); } catch { /* polling nunca libera sem limite */ }
  }
  const atualizado = await banco.pedidoPagamento.findUnique({ where:{id:pedido.id}, select:{id:true,status:true,valorCentavos:true,moeda:true,expiraEm:true} });
  return NextResponse.json(atualizado && { id: atualizado.id, status: atualizado.status, valorCentavos: atualizado.valorCentavos, moeda: atualizado.moeda, expiraEm: atualizado.expiraEm }, { headers: { "Cache-Control": "no-store" } });
}; }
export const GET=Object.assign(createGetPedidoHandler(), { createForTest: createGetPedidoHandler });
