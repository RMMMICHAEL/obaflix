import { prisma } from "@/lib/prisma";
import { invalidarEntitlements } from "@/lib/entitlements";
import { audit } from "@/lib/auditLog";
import { criarConfirmadorBlackcat, type ConfirmacaoBlackcat } from "./blackcat";
import { fimDoPeriodo, type Duracao } from "./vigencia";
import { ehPlanoCortes } from "../planos";
import { abrirRevisao, marcarPedidoEmRevisao, motivoDaConfirmacao, type MotivoDeRevisao } from "./revisao";
import { confirmadorDeCobranca } from "./simulado";
import { notificarPrimeiroAcesso, type ContaDoComprador } from "../primeiroAcesso";

type Pedido = { id: string; userId: string | null; planoId: string; planoPrecoId: string; status: string; valorCentavos: number; moeda: string; duracaoDias: number | null; transacaoId: string | null; expiraEm: Date | null };
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

/** A duração congelada no pedido: meses de calendário ou dias. `null` se nenhuma for válida. */
export function duracaoDoPedido(p: { duracaoDias?: number | null; duracaoMeses?: number | null }): Duracao | null {
  if (typeof p.duracaoMeses === "number") return { tipo: "meses", meses: p.duracaoMeses };
  if (typeof p.duracaoDias === "number") return { tipo: "dias", dias: p.duracaoDias };
  return null;
}

export type PlanoDeAtivacao =
  | { ok: true; iniciaEm: Date; terminaEm: Date; cancelar: string[] }
  | { ok: false; motivo: "periodo_em_aberto" | "substituicao_divergente" | "duracao_invalida" | "operacao_invalida" };

/**
 * Onde o período pago começa, e o que ele substitui. Função pura.
 *
 * Refeita no instante da confirmação, contra os períodos que existem **agora** —
 * não os do momento do pedido:
 *
 *  - **nova**: exige nenhum período em aberto; começa agora;
 *  - **renovação** e **downgrade**: começam no fim do último período em aberto
 *    (ou agora, se ele venceu enquanto o PIX esperava). Renovação acrescenta a
 *    duração ao vencimento; downgrade só vale depois do período pago;
 *  - **upgrade**: começa agora e cancela os períodos em aberto. Todos precisam
 *    estar entre os que o pedido creditou; um período que o pedido não conhecia
 *    (outra compra confirmada no meio) leva a revisão manual, porque o crédito
 *    cobrado não o incluiu.
 */
export function planejarAtivacao(
  pedido: { operacao?: string | null; assinaturasSubstituidas?: string[] | null; duracao: Duracao | null },
  abertos: { id: string; terminaEm: Date }[],
  agora: Date,
): PlanoDeAtivacao {
  if (!pedido.duracao) return { ok: false, motivo: "duracao_invalida" };
  const operacao = pedido.operacao ?? "nova";
  let iniciaEm: Date;
  let cancelar: string[] = [];

  if (operacao === "nova") {
    if (abertos.length > 0) return { ok: false, motivo: "periodo_em_aberto" };
    iniciaEm = agora;
  } else if (operacao === "renovacao" || operacao === "downgrade") {
    const fim = Math.max(agora.getTime(), ...abertos.map((a) => a.terminaEm.getTime()));
    iniciaEm = new Date(fim);
  } else if (operacao === "upgrade") {
    const creditados = new Set(pedido.assinaturasSubstituidas ?? []);
    if (!abertos.every((a) => creditados.has(a.id))) return { ok: false, motivo: "substituicao_divergente" };
    iniciaEm = agora;
    cancelar = abertos.map((a) => a.id);
  } else {
    return { ok: false, motivo: "operacao_invalida" };
  }

  try {
    return { ok: true, iniciaEm, terminaEm: fimDoPeriodo(iniciaEm, pedido.duracao), cancelar };
  } catch {
    return { ok: false, motivo: "duracao_invalida" };
  }
}

const MAX_TENTATIVAS_TRANSACAO = 3;
/** Portas estreitas para testes; produção usa os defaults abaixo. */
export interface DependenciasConfirmacao { prisma: typeof prisma; consultarStatusBlackcat: (id:string)=>ReturnType<NonNullable<ReturnType<typeof criarConfirmadorBlackcat>>>; invalidarEntitlements: typeof invalidarEntitlements; agora: ()=>Date; notificarPrimeiroAcesso: (c: ContaDoComprador)=>Promise<unknown>; }
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
  const confirmar = injetadas.consultarStatusBlackcat ?? confirmadorDeCobranca(); if (!confirmar) return { resultado: "configuracao" };
  const externo = await confirmar(pedido.transacaoId);
  if (!externo.ok) { audit("billing_reconcile_failed", { userId: pedido.userId, detail: externo.falha }); return { resultado: "retry" }; }
  const agora = relogio(); const decisao = decidirConfirmacao(pedido, externo.confirmacao, agora); let userParaInvalidar: string | null = null; let comprador: ContaDoComprador | null = null;
  try { await transacaoComRetry(banco, async (tx) => {
    comprador = null;
    const incluir = { assinatura: true, plano: { select: { cortesNivel: true } } } as const;
    let atual = await tx.pedidoPagamento.findUnique({ where: { id: pedidoId }, include: incluir }); if (!atual) return;
    // Compra sem login: a conta nasce, ou é vinculada pelo e-mail, só com o
    // pagamento confirmado pelo provedor. Conta existente não tem nada alterado
    // (`update: {}`): sem senha nova, sem acesso por informar o e-mail.
    if (!atual.userId && atual.emailComprador && externo.confirmacao.status === "PAID" && atual.transacaoId === externo.confirmacao.transactionId) {
      const conta = await tx.user.upsert({ where: { email: atual.emailComprador }, create: { email: atual.emailComprador, nome: atual.nomeComprador }, update: {}, select: { id: true, senhaHash: true } });
      comprador = { userId: conta.id, email: atual.emailComprador, semSenha: !conta.senhaHash };
      atual = await tx.pedidoPagamento.update({ where: { id: atual.id }, data: { userId: conta.id }, include: incluir });
      // Revisão aberta antes da conta passa a ser dela: trava, consulta e exclusão de conta a enxergam.
      await tx.revisaoPagamento.updateMany({ where: { pedidoId: atual.id, userId: null }, data: { userId: conta.id } });
    }
    const userId = atual.userId;
    // Repetição após commit é sucesso idempotente; nunca reabre uma compra paga.
    if (atual.status === "PAGO" && atual.assinatura && externo.confirmacao.status !== "REFUNDED") return;
    const d = decidirConfirmacao(atual, externo.confirmacao, agora);
    if (d === "MANTER") return;
    if (d === "REVISAR") { await marcarPedidoEmRevisao(tx, { pedidoId: atual.id, userId: atual.userId, motivo: motivoDaConfirmacao(atual, externo.confirmacao, agora) }); return; }
    if (d === "EXPIRAR" || d === "CANCELAR") { await tx.pedidoPagamento.update({ where:{id:atual.id},data:{status:d === "EXPIRAR" ? "EXPIRADO" : "CANCELADO"} }); return; }
    if (d === "ESTORNAR") {
      // O evento financeiro confirmado é registrado já, e o pedido estornado
      // deixa de conceder direito. Em upgrade, restaurar os períodos que ele
      // substituiu exige análise: o caso é aberto e nada é restaurado aqui, nem
      // crédito é criado.
      await tx.pedidoPagamento.update({ where:{id:atual.id},data:{status:"ESTORNADO"} });
      if (atual.assinatura?.status === "ATIVA") await tx.assinatura.update({where:{id:atual.assinatura.id},data:{status:"CANCELADA"}});
      if ((atual as { operacao?: string }).operacao === "upgrade") await abrirRevisao(tx, { pedidoId: atual.id, userId: atual.userId, motivo: "estorno_upgrade" });
      userParaInvalidar=atual.userId; return;
    }
    if (atual.assinatura) { if (atual.status !== "PAGO") await marcarPedidoEmRevisao(tx, { pedidoId: atual.id, userId: atual.userId, motivo: "pedido_ja_vinculado" }); return; }
    const extra = atual as typeof atual & { operacao?: string | null; assinaturasSubstituidas?: string[] | null; duracaoMeses?: number | null; telasAdicionais?: number | null; servidorVip?: boolean | null };
    // Só períodos da mesma família: ativar Cortes nunca encerra o tradicional, e vice-versa.
    const familia=ehPlanoCortes((atual as { plano?: { cortesNivel?: string } | null }).plano?.cortesNivel) ? { not: "nenhum" } : "nenhum";
    // Ativar exige PAID com a transação do pedido, que acima já garantiu a conta.
    if (!userId) throw new Error("pedido_sem_conta");
    const abertos=await tx.assinatura.findMany({where:{userId,status:"ATIVA",terminaEm:{gt:agora},plano:{cortesNivel:familia}},select:{id:true,terminaEm:true}});
    const plano=planejarAtivacao({operacao:extra.operacao,assinaturasSubstituidas:extra.assinaturasSubstituidas,duracao:duracaoDoPedido(extra)},abertos,agora);
    if (!plano.ok) { await marcarPedidoEmRevisao(tx, { pedidoId: atual.id, userId: atual.userId, motivo: `ativacao_${plano.motivo}` as MotivoDeRevisao }); audit("billing_payment_review",{userId:atual.userId,detail:`ativacao ${plano.motivo}: pedido ${atual.id}`}); return; }
    for (const id of plano.cancelar) await tx.assinatura.update({where:{id},data:{status:"CANCELADA",observacao:`substituida pelo pedido ${atual.id}`}});
    await tx.assinatura.create({data:{userId,planoId:atual.planoId,planoPrecoId:atual.planoPrecoId,pedidoId:atual.id,status:"ATIVA",origem:"pagamento",iniciaEm:plano.iniciaEm,terminaEm:plano.terminaEm,telasAdicionais:extra.telasAdicionais ?? 0,servidorVip:extra.servidorVip === true}});
    await tx.pedidoPagamento.update({where:{id:atual.id},data:{status:"PAGO"}}); userParaInvalidar=atual.userId;
  }); } catch (erro) {
    if (!conflitoPedidoId(erro)) throw erro;
    const reconciliado=await banco.pedidoPagamento.findUnique({where:{id:pedidoId},include:{assinatura:true}});
    const a=reconciliado?.assinatura;
    if (reconciliado?.status === "PAGO" && a && a.pedidoId === pedidoId && a.userId === reconciliado.userId && a.planoId === reconciliado.planoId && a.planoPrecoId === reconciliado.planoPrecoId) return {resultado:"idempotente"};
    if (reconciliado) await banco.$transaction((tx) => marcarPedidoEmRevisao(tx, { pedidoId, userId: reconciliado.userId, motivo: "reconciliacao_inconsistente" }));
    return {resultado:"inconsistencia"};
  }
  // Só depois do commit, e uma vez: a conta é vinculada uma única vez. E-mail que falha não desfaz nada.
  const avisar = comprador as ContaDoComprador | null;
  if (avisar) try { await (injetadas.notificarPrimeiroAcesso ?? notificarPrimeiroAcesso)(avisar); } catch { audit("email_failed",{userId:avisar.userId,detail:"primeiro_acesso apos_commit"}); }
  if(userParaInvalidar) try { await invalidar(userParaInvalidar); } catch { audit("billing_entitlements_invalidation_failed",{userId:userParaInvalidar,detail:"apos_commit"}); }
  audit(decisao === "ATIVAR" ? "billing_payment_confirmed" : decisao === "ESTORNAR" ? "billing_payment_refunded" : "billing_payment_review",{userId:pedido.userId,detail:`pedido ${pedidoId}`});
  return { resultado:decisao.toLowerCase() };
}
