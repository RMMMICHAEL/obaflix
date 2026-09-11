import { prisma } from "@/lib/prisma";
import { invalidarEntitlements } from "@/lib/entitlements";
import { audit } from "@/lib/auditLog";
import { criarConfirmadorBlackcat, type ConfirmacaoBlackcat } from "./blackcat";

type Pedido = { id: string; userId: string; planoId: string; planoPrecoId: string; status: string; valorCentavos: number; moeda: string; duracaoDias: number; transacaoId: string | null; expiraEm: Date | null };
export type Decisao = "MANTER" | "ATIVAR" | "EXPIRAR" | "CANCELAR" | "ESTORNAR" | "REVISAR";
export function decidirConfirmacao(p: Pedido, c: ConfirmacaoBlackcat, agora: Date): Decisao {
  if (p.status === "REVISAO_MANUAL") return "MANTER";
  if (!p.transacaoId || p.transacaoId !== c.transactionId || p.valorCentavos !== c.amount) return "REVISAR";
  if (c.status === "PENDING") return p.expiraEm && p.expiraEm <= agora ? "EXPIRAR" : "MANTER";
  if (c.status === "CANCELLED") return "CANCELAR";
  if (c.status === "REFUNDED") return "ESTORNAR";
  if (c.status !== "PAID") return "REVISAR";
  if (p.expiraEm && p.expiraEm <= agora && (!c.paidAt || c.paidAt > p.expiraEm)) return "REVISAR";
  return ["AGUARDANDO", "CONFIRMANDO"].includes(p.status) ? "ATIVAR" : "REVISAR";
}
export function periodoAssinatura(agora: Date, dias: number) { if (!Number.isInteger(dias) || dias <= 0 || Number.isNaN(agora.getTime())) throw new Error("periodo_invalido"); const terminaEm = new Date(agora.getTime() + dias * 86400000); if (Number.isNaN(terminaEm.getTime())) throw new Error("periodo_invalido"); return { iniciaEm: agora, terminaEm }; }
const MAX_TENTATIVAS_TRANSACAO = 3;
/** Portas estreitas para testes; produção usa os defaults abaixo. */
export interface DependenciasConfirmacao { prisma: typeof prisma; consultarStatusBlackcat: (id:string)=>ReturnType<NonNullable<ReturnType<typeof criarConfirmadorBlackcat>>>; invalidarEntitlements: typeof invalidarEntitlements; agora: ()=>Date; }
function conflitoRetryable(erro: unknown) { return typeof erro === "object" && erro !== null && "code" in erro && (erro as {code?:unknown}).code === "P2034"; }
function conflitoPedidoId(erro: unknown) { const e=erro as {code?:unknown;meta?:{target?:unknown}}; return e?.code === "P2002" && Array.isArray(e.meta?.target) && e.meta.target.includes("pedidoId"); }
async function transacaoComRetry<T>(banco: typeof prisma, fn: (tx: Parameters<typeof prisma.$transaction>[0] extends (arg: infer U) => unknown ? U : never) => Promise<T>): Promise<T> {
  let ultimo: unknown;
  for (let tentativa=0; tentativa<MAX_TENTATIVAS_TRANSACAO; tentativa++) try { return await banco.$transaction(fn, { isolationLevel:"Serializable" }); } catch (erro) { ultimo=erro; if (!conflitoRetryable(erro) || tentativa === MAX_TENTATIVAS_TRANSACAO-1) throw erro; }
  throw ultimo;
}
/** Único caminho que altera PAGO/ESTORNADO e cria/cancela uma assinatura. */
export async function confirmarPedidoPorId(pedidoId: string, injetadas: Partial<DependenciasConfirmacao> = {}): Promise<{ resultado: string }> {
  const banco=injetadas.prisma ?? prisma; const relogio=injetadas.agora ?? (()=>new Date()); const invalidar=injetadas.invalidarEntitlements ?? invalidarEntitlements;
  if (process.env.BLACKCAT_CONFIRMACAO_ATIVA !== "true") return { resultado: "desligada" };
  const pedido = await banco.pedidoPagamento.findUnique({ where: { id: pedidoId }, select: { id:true,userId:true,planoId:true,planoPrecoId:true,status:true,valorCentavos:true,moeda:true,duracaoDias:true,transacaoId:true,expiraEm:true } });
  if (!pedido?.transacaoId) return { resultado: "sem_transacao" };
  const confirmar = injetadas.consultarStatusBlackcat ?? criarConfirmadorBlackcat(); if (!confirmar) return { resultado: "configuracao" };
  const externo = await confirmar(pedido.transacaoId);
  if (!externo.ok) { audit("billing_reconcile_failed", { userId: pedido.userId, detail: externo.falha }); return { resultado: "retry" }; }
  const agora = relogio(); const decisao = decidirConfirmacao(pedido, externo.confirmacao, agora); let userParaInvalidar: string | null = null;
  try { await transacaoComRetry(banco, async (tx) => {
    const atual = await tx.pedidoPagamento.findUnique({ where: { id: pedidoId }, include: { assinatura: true } }); if (!atual) return;
    // Repetição após commit é sucesso idempotente; nunca reabre uma compra paga.
    if (atual.status === "PAGO" && atual.assinatura && externo.confirmacao.status !== "REFUNDED") return;
    const d = decidirConfirmacao(atual, externo.confirmacao, agora);
    if (d === "MANTER") return;
    if (d === "REVISAR") { await tx.pedidoPagamento.update({ where:{id:atual.id},data:{status:"REVISAO_MANUAL"} }); return; }
    if (d === "EXPIRAR" || d === "CANCELAR") { await tx.pedidoPagamento.update({ where:{id:atual.id},data:{status:d === "EXPIRAR" ? "EXPIRADO" : "CANCELADO"} }); return; }
    if (d === "ESTORNAR") { await tx.pedidoPagamento.update({ where:{id:atual.id},data:{status:"ESTORNADO"} }); if (atual.assinatura?.status === "ATIVA") await tx.assinatura.update({where:{id:atual.assinatura.id},data:{status:"CANCELADA"}}); userParaInvalidar=atual.userId; return; }
    if (atual.assinatura) { if (atual.status !== "PAGO") await tx.pedidoPagamento.update({where:{id:atual.id},data:{status:"REVISAO_MANUAL"}}); return; }
    const ativas=await tx.assinatura.findMany({where:{userId:atual.userId,status:"ATIVA",iniciaEm:{lte:agora},terminaEm:{gt:agora}},select:{id:true}});
    if (ativas.length) { await tx.pedidoPagamento.update({where:{id:atual.id},data:{status:"REVISAO_MANUAL"}}); return; }
    await tx.assinatura.create({data:{userId:atual.userId,planoId:atual.planoId,planoPrecoId:atual.planoPrecoId,pedidoId:atual.id,status:"ATIVA",origem:"pagamento",...periodoAssinatura(agora,atual.duracaoDias)}});
    await tx.pedidoPagamento.update({where:{id:atual.id},data:{status:"PAGO"}}); userParaInvalidar=atual.userId;
  }); } catch (erro) {
    if (!conflitoPedidoId(erro)) throw erro;
    const reconciliado=await banco.pedidoPagamento.findUnique({where:{id:pedidoId},include:{assinatura:true}});
    const a=reconciliado?.assinatura;
    if (reconciliado?.status === "PAGO" && a && a.pedidoId === pedidoId && a.userId === reconciliado.userId && a.planoId === reconciliado.planoId && a.planoPrecoId === reconciliado.planoPrecoId) return {resultado:"idempotente"};
    if (reconciliado) await banco.pedidoPagamento.update({where:{id:pedidoId},data:{status:"REVISAO_MANUAL"}});
    return {resultado:"inconsistencia"};
  }
  if(userParaInvalidar) try { await invalidar(userParaInvalidar); } catch { audit("billing_entitlements_invalidation_failed",{userId:userParaInvalidar,detail:"apos_commit"}); }
  audit(decisao === "ATIVAR" ? "billing_payment_confirmed" : decisao === "ESTORNAR" ? "billing_payment_refunded" : "billing_payment_review",{userId:pedido.userId,detail:`pedido ${pedidoId}`});
  return { resultado:decisao.toLowerCase() };
}
