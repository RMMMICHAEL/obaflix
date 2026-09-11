import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { confirmarPedidoPorId } from "@/lib/billing/confirmacao";
export const dynamic = "force-dynamic";
export function createBillingReconcileHandler(deps:any={}) { const banco=deps.prisma??prisma, confirmar=deps.confirmarPedidoPorId??confirmarPedidoPorId, env=deps.env??process.env; return async function GET(req: NextRequest) {
  const secret=env.CRON_SECRET;
  if(!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({error:"Não autorizado"},{status:401});
  if(env.BLACKCAT_CONFIRMACAO_ATIVA !== "true") return NextResponse.json({processados:0},{headers:{"Cache-Control":"no-store"}});
  const pedidos=await banco.pedidoPagamento.findMany({where:{status:"AGUARDANDO",transacaoId:{not:null}},orderBy:{criadoEm:"asc"},take:25,select:{id:true}});
  let processados=0; for(const pedido of pedidos) { try { await confirmar(pedido.id); processados++; } catch { /* um pedido não aborta o lote */ } }
  return NextResponse.json({processados},{headers:{"Cache-Control":"no-store"}});
}; }
export const GET=createBillingReconcileHandler();
