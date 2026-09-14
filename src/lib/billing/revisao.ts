import type { Prisma } from "@prisma/client";
import type { ConfirmacaoBlackcat } from "./blackcat";

/**
 * Revisão manual de pagamentos — o registro do caso.
 *
 * `REVISAO_MANUAL` no pedido diz "não ative". Isto aqui diz **por quê, desde
 * quando e o que já foi feito**: um caso por pedido, com motivo em código
 * interno e histórico imutável. As ações que resolvem um caso ficam em
 * `revisaoAcoes.ts`.
 *
 * Nenhuma função daqui concede direito, cria assinatura ou marca pagamento.
 */

/** Códigos internos. Estáveis: aparecem no banco, no log e na consulta admin. */
export const MOTIVOS_DE_REVISAO = {
  criacao_valor_divergente: "Venda criada no provedor com valor diferente do pedido",
  criacao_falha_com_transacao: "Falha do provedor na criação, com transação conhecida",
  confirmacao_divergente: "Transação ou valor informados pelo provedor diferentes do pedido",
  confirmacao_status_desconhecido: "Status do provedor fora dos estados esperados",
  pago_apos_expiracao: "Pagamento confirmado depois do vencimento do PIX",
  pedido_em_estado_inesperado: "Confirmação para pedido que não aguardava pagamento",
  pedido_ja_vinculado: "Assinatura já vinculada a este pedido em estado inconsistente",
  ativacao_periodo_em_aberto: "Compra nova confirmada com período já em aberto",
  ativacao_substituicao_divergente: "Upgrade confirmado com períodos diferentes dos creditados",
  ativacao_duracao_invalida: "Duração do pedido inválida na ativação",
  ativacao_operacao_invalida: "Operação do pedido inválida na ativação",
  estorno_upgrade: "Estorno confirmado de upgrade: recompor direitos",
  reconciliacao_inconsistente: "Conflito ao gravar a assinatura do pedido",
} as const;

export type MotivoDeRevisao = keyof typeof MOTIVOS_DE_REVISAO;

export const RESOLUCOES_DE_REVISAO = {
  ativada: "Pagamento confirmado no provedor; assinatura ativada",
  estorno_confirmado: "Estorno confirmado no provedor; direitos do pedido cancelados",
  nao_pago_confirmado: "Provedor confirma que não houve pagamento",
  upgrade_recomposto: "Estorno de upgrade: períodos substituídos restaurados",
  upgrade_sem_periodo_restante: "Estorno de upgrade: nenhum período substituído ainda vigente",
  encerrada_sem_alteracao: "Encerrada pelo operador sem alterar pedido ou direitos",
} as const;

export type ResolucaoDeRevisao = keyof typeof RESOLUCOES_DE_REVISAO;

export const TIPOS_DE_EVENTO_DA_REVISAO = [
  "aberta", "motivo_registrado", "acao_executada", "acao_recusada", "resolvida",
] as const;

/** Mensagem única ao comprador. Não promete prazo nem notificação. */
export const MENSAGEM_DE_REVISAO_AO_COMPRADOR =
  "Seu pagamento está em análise. Não faça outro pagamento para esta assinatura. Acompanhe o status por aqui.";

export function ehMotivoDeRevisao(v: unknown): v is MotivoDeRevisao {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(MOTIVOS_DE_REVISAO, v);
}

/**
 * Por que a confirmação decidiu `REVISAR`. Espelha `decidirConfirmacao`, na
 * mesma ordem, para o código gravado ser o motivo real.
 */
export function motivoDaConfirmacao(
  p: { status: string; valorCentavos: number; transacaoId: string | null; expiraEm: Date | null },
  c: ConfirmacaoBlackcat,
  agora: Date,
): MotivoDeRevisao {
  if (!p.transacaoId || p.transacaoId !== c.transactionId || p.valorCentavos !== c.amount) return "confirmacao_divergente";
  if (!["PENDING", "PAID", "CANCELLED", "REFUNDED"].includes(c.status)) return "confirmacao_status_desconhecido";
  if (c.status === "PAID" && p.expiraEm && p.expiraEm <= agora && (!c.paidAt || c.paidAt > p.expiraEm)) {
    return "pago_apos_expiracao";
  }
  return "pedido_em_estado_inesperado";
}

/** Últimos 4 caracteres. A consulta admin identifica a venda sem expor o id inteiro. */
export function mascararTransacao(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length <= 4 ? "****" : `****${id.slice(-4)}`;
}

// ── Banco ────────────────────────────────────────────────────────────────────

export type TxComTrava = Pick<Prisma.TransactionClient, "$executeRaw">;
export type TxDeRevisao = TxComTrava & Pick<Prisma.TransactionClient, "revisaoPagamento" | "revisaoPagamentoEvento">;

/**
 * Trava transacional por conta, compartilhada por quem cria pedido e por quem
 * abre ou resolve revisão.
 *
 * É o que torna "não comprar com revisão pendente" verdade também com
 * requisições simultâneas: a verificação e a gravação acontecem com a conta
 * travada, e a trava só é solta no fim da transação.
 *
 * `$executeRaw`, e não `$queryRaw`: `pg_advisory_xact_lock` devolve `void`, que
 * o Prisma não desserializa.
 */
export async function travarContaParaCobranca(tx: TxComTrava, userId: string): Promise<void> {
  const chave = `cobranca:${userId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chave}, 0))`;
}

/**
 * Abre o caso, ou acrescenta o motivo ao caso pendente do mesmo pedido.
 * Chamada **dentro** da transação que muda o pedido.
 */
export async function abrirRevisao(
  tx: TxDeRevisao,
  a: { pedidoId: string; userId: string; motivo: MotivoDeRevisao; ator?: string },
): Promise<{ revisaoId: string; nova: boolean }> {
  await travarContaParaCobranca(tx, a.userId);
  const ator = a.ator ?? "sistema";

  const aberta = await tx.revisaoPagamento.findFirst({
    where: { pedidoId: a.pedidoId, status: "PENDENTE" },
    select: { id: true },
  });
  if (aberta) {
    await tx.revisaoPagamentoEvento.create({
      data: { revisaoId: aberta.id, tipo: "motivo_registrado", codigo: a.motivo, ator },
    });
    return { revisaoId: aberta.id, nova: false };
  }

  const criada = await tx.revisaoPagamento.create({
    data: { pedidoId: a.pedidoId, userId: a.userId, motivo: a.motivo, status: "PENDENTE" },
    select: { id: true },
  });
  await tx.revisaoPagamentoEvento.create({
    data: { revisaoId: criada.id, tipo: "aberta", codigo: a.motivo, ator },
  });
  return { revisaoId: criada.id, nova: true };
}

/** Pedido em `REVISAO_MANUAL` e caso aberto, na mesma transação. */
export async function marcarPedidoEmRevisao(
  tx: TxDeRevisao & Pick<Prisma.TransactionClient, "pedidoPagamento">,
  a: { pedidoId: string; userId: string; motivo: MotivoDeRevisao },
): Promise<void> {
  await tx.pedidoPagamento.update({ where: { id: a.pedidoId }, data: { status: "REVISAO_MANUAL" } });
  await abrirRevisao(tx, a);
}
