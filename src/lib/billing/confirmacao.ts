import { prisma } from "@/lib/prisma";
import { invalidarEntitlements } from "@/lib/entitlements";
import { audit } from "@/lib/auditLog";
import { criarConfirmadorBlackcat, type ConfirmacaoBlackcat } from "./blackcat";
import { fimDoPeriodo, type Duracao } from "./vigencia";
import { ehPlanoCortes } from "../planos";
import { abrirRevisao, marcarPedidoEmRevisao, motivoDaConfirmacao, type MotivoDeRevisao } from "./revisao";
import { confirmadorDoPedido } from "./simulado";
import { notificarPrimeiroAcesso, type ContaDoComprador } from "../primeiroAcesso";
import { OFERTAS_CAKTO, TAXA_SERVICO_CAKTO_CENTAVOS } from "./cakto";
import { enviarPurchaseMeta, type CompraParaMeta, type ResultadoMeta } from "../metaCapi";

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
export interface DependenciasConfirmacao { prisma: typeof prisma; consultarStatusBlackcat: (id:string, esperado?: { planoId?: string })=>ReturnType<NonNullable<ReturnType<typeof criarConfirmadorBlackcat>>>; invalidarEntitlements: typeof invalidarEntitlements; agora: ()=>Date; notificarPrimeiroAcesso: (c: ContaDoComprador)=>Promise<unknown>; enviarPurchaseMeta: (c: CompraParaMeta)=>Promise<ResultadoMeta>; }
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
  const pedido = await banco.pedidoPagamento.findUnique({ where: { id: pedidoId }, select: { id:true,userId:true,planoId:true,planoPrecoId:true,status:true,valorCentavos:true,moeda:true,duracaoDias:true,transacaoId:true,expiraEm:true,provedor:true } });
  // Blackcat segue atrás de BLACKCAT_CONFIRMACAO_ATIVA; Cakto confirma sempre que configurada (só consulta; nada é cobrado aqui).
  if ((pedido?.provedor ?? "blackcat") !== "cakto" && process.env.BLACKCAT_CONFIRMACAO_ATIVA !== "true") return { resultado: "desligada" };
  if (!pedido?.transacaoId) return { resultado: "sem_transacao" };
  const confirmar = injetadas.consultarStatusBlackcat ?? confirmadorDoPedido(pedido.provedor ?? "blackcat"); if (!confirmar) return { resultado: "configuracao" };
  const externo = await confirmar(pedido.transacaoId, { planoId: pedido.planoId });
  if (!externo.ok) { audit("billing_reconcile_failed", { userId: pedido.userId, detail: externo.falha }); return { resultado: "retry" }; }
  const agora = relogio(); const decisao = decidirConfirmacao(pedido, externo.confirmacao, agora); let userParaInvalidar: string | null = null; let comprador: ContaDoComprador | null = null; let compraMeta: CompraParaMeta | null = null;
  try { await transacaoComRetry(banco, async (tx) => {
    comprador = null; compraMeta = null;
    const incluir = { assinatura: true, plano: { select: { cortesNivel: true, nome: true } } } as const;
    const atual = await tx.pedidoPagamento.findUnique({ where: { id: pedidoId }, include: incluir }); if (!atual) return;
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
    // Compra sem login: a conta é só consultada aqui; nasce ou é vinculada abaixo,
    // depois que o pagamento validou (ATIVAR) e o período pode ser ativado.
    if (!atual.userId && !atual.emailComprador) throw new Error("pedido_sem_conta");
    const existente = atual.userId ? null : await tx.user.findUnique({ where: { email: atual.emailComprador! }, select: { id: true } });
    let userId = atual.userId ?? existente?.id ?? null;
    const abertos=userId ? await tx.assinatura.findMany({where:{userId,status:"ATIVA",terminaEm:{gt:agora},plano:{cortesNivel:familia}},select:{id:true,terminaEm:true}}) : [];
    const plano=planejarAtivacao({operacao:extra.operacao,assinaturasSubstituidas:extra.assinaturasSubstituidas,duracao:duracaoDoPedido(extra)},abertos,agora);
    if (!plano.ok) { await marcarPedidoEmRevisao(tx, { pedidoId: atual.id, userId: atual.userId, motivo: `ativacao_${plano.motivo}` as MotivoDeRevisao }); audit("billing_payment_review",{userId:atual.userId,detail:`ativacao ${plano.motivo}: pedido ${atual.id}`}); return; }
    if (!atual.userId) {
      // Conta existente não tem nada alterado (`update: {}`): sem senha nova, sem acesso por informar o e-mail.
      const conta = await tx.user.upsert({ where: { email: atual.emailComprador! }, create: { email: atual.emailComprador!, nome: atual.nomeComprador, dataNascimento: atual.nascimentoComprador }, update: {}, select: { id: true, senhaHash: true, googleSub: true } });
      comprador = { userId: conta.id, email: atual.emailComprador!, semSenha: !conta.senhaHash && !conta.googleSub };
      userId = conta.id;
      await tx.pedidoPagamento.update({ where: { id: atual.id }, data: { userId } });
      // Revisão anterior do pedido passa a ser da conta: trava, consulta e exclusão de conta a enxergam.
      await tx.revisaoPagamento.updateMany({ where: { pedidoId: atual.id, userId: null }, data: { userId } });
    }
    if (!userId) throw new Error("pedido_sem_conta");
    if (!comprador && ehPlanoCortes(atual.plano?.cortesNivel)) {
      const conta = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (conta) comprador = { userId, email: conta.email, semSenha: false };
    }
    if (comprador) comprador.compra = {
      pedidoId: atual.id, plano: atual.plano?.nome ?? atual.planoId,
      valorCentavos: atual.valorCentavos, moeda: atual.moeda,
      iniciaEm: plano.iniciaEm, terminaEm: plano.terminaEm,
      ...(atual.provedor === "cakto" && OFERTAS_CAKTO[atual.planoId]?.centavos === atual.valorCentavos
        ? { valorTotalCentavos: atual.valorCentavos + TAXA_SERVICO_CAKTO_CENTAVOS } : {}),
    };
    for (const id of plano.cancelar) await tx.assinatura.update({where:{id},data:{status:"CANCELADA",observacao:`substituida pelo pedido ${atual.id}`}});
    await tx.assinatura.create({data:{userId,planoId:atual.planoId,planoPrecoId:atual.planoPrecoId,pedidoId:atual.id,status:"ATIVA",origem:"pagamento",iniciaEm:plano.iniciaEm,terminaEm:plano.terminaEm,telasAdicionais:extra.telasAdicionais ?? 0,servidorVip:extra.servidorVip === true}});
    await tx.pedidoPagamento.update({where:{id:atual.id},data:{status:"PAGO"}}); userParaInvalidar=userId;
    // Purchase no servidor: só compra Cortes Cakto recém-ativada, com consentimento registrado no pedido e sem envio anterior.
    if (atual.provedor === "cakto" && ehPlanoCortes(atual.plano?.cortesNivel) && atual.consentimentoAnunciosEm && !atual.metaPurchaseEnviadoEm) {
      const comTaxa = OFERTAS_CAKTO[atual.planoId]?.centavos === atual.valorCentavos;
      compraMeta = { pedidoId: atual.id, planoId: atual.planoId, valorTotalCentavos: atual.valorCentavos + (comTaxa ? TAXA_SERVICO_CAKTO_CENTAVOS : 0), fbp: atual.metaFbp, fbc: atual.metaFbc, em: agora };
    }
  }); } catch (erro) {
    if (!conflitoPedidoId(erro)) throw erro;
    const reconciliado=await banco.pedidoPagamento.findUnique({where:{id:pedidoId},include:{assinatura:true}});
    const a=reconciliado?.assinatura;
    if (reconciliado?.status === "PAGO" && a && a.pedidoId === pedidoId && a.userId === reconciliado.userId && a.planoId === reconciliado.planoId && a.planoPrecoId === reconciliado.planoPrecoId) return {resultado:"idempotente"};
    if (reconciliado) await banco.$transaction((tx) => marcarPedidoEmRevisao(tx, { pedidoId, userId: reconciliado.userId, motivo: "reconciliacao_inconsistente" }));
    return {resultado:"inconsistencia"};
  }
  // Só a transação que ativa avisa, após commit. Repetições não enviam; falhas não desfazem a assinatura.
  const avisar = comprador as ContaDoComprador | null;
  if (avisar) try { await (injetadas.notificarPrimeiroAcesso ?? notificarPrimeiroAcesso)(avisar); } catch { audit("email_failed",{userId:avisar.userId,detail:"primeiro_acesso apos_commit"}); }
  if(userParaInvalidar) try { await invalidar(userParaInvalidar); } catch { audit("billing_entitlements_invalidation_failed",{userId:userParaInvalidar,detail:"apos_commit"}); }
  // Depois do e-mail e da invalidação: falha ou lentidão da Meta nunca atrasa nem desfaz a ativação.
  const meta = compraMeta as CompraParaMeta | null;
  if (meta) try {
    const r = await (injetadas.enviarPurchaseMeta ?? enviarPurchaseMeta)(meta);
    if (r.ok) { await banco.pedidoPagamento.updateMany({ where: { id: meta.pedidoId, metaPurchaseEnviadoEm: null }, data: { metaPurchaseEnviadoEm: relogio() } }); audit("meta_capi_purchase_sent", { userId: pedido.userId, detail: `pedido ${meta.pedidoId}` }); }
    else audit("meta_capi_purchase_failed", { userId: pedido.userId, detail: `pedido ${meta.pedidoId} ${r.motivo}` });
  } catch { audit("meta_capi_purchase_failed", { userId: pedido.userId, detail: `pedido ${meta.pedidoId} erro` }); }
  audit(decisao === "ATIVAR" ? "billing_payment_confirmed" : decisao === "ESTORNAR" ? "billing_payment_refunded" : "billing_payment_review",{userId:pedido.userId,detail:`pedido ${pedidoId}`});
  return { resultado:decisao.toLowerCase() };
}
