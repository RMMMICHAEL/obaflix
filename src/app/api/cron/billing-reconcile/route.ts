import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { confirmarPedidoPorId } from "@/lib/billing/confirmacao";
export const dynamic = "force-dynamic";
function createBillingReconcileHandler(deps:any={}) { const banco=deps.prisma??prisma, confirmar=deps.confirmarPedidoPorId??confirmarPedidoPorId, env=deps.env??process.env; return async function GET(req: NextRequest) {
  const secret=env.CRON_SECRET;
  if(!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({error:"Não autorizado"},{status:401});
  // Cada provedor com a própria chave: Blackcat por BLACKCAT_CONFIRMACAO_ATIVA, Cakto por credenciais configuradas.
  const provedores=[...(env.BLACKCAT_CONFIRMACAO_ATIVA === "true" ? ["blackcat","simulado"] : []), ...(env.CAKTO_CLIENT_ID && env.CAKTO_CLIENT_SECRET ? ["cakto"] : [])];
  if(provedores.length === 0) return NextResponse.json({processados:0},{headers:{"Cache-Control":"no-store"}});
  const pedidos=await banco.pedidoPagamento.findMany({where:{status:"AGUARDANDO",transacaoId:{not:null},provedor:{in:provedores}},orderBy:{criadoEm:"asc"},take:25,select:{id:true}});
  let processados=0; for(const pedido of pedidos) { try { await confirmar(pedido.id); processados++; } catch { /* um pedido não aborta o lote */ } }
  return NextResponse.json({processados},{headers:{"Cache-Control":"no-store"}});
}; }
export const GET=Object.assign(createBillingReconcileHandler(), { createForTest: createBillingReconcileHandler });
