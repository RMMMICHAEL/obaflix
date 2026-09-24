import { prisma } from "@/lib/prisma";
import { invalidarEntitlements } from "@/lib/entitlements";
import { audit } from "@/lib/auditLog";
import type { ConfirmacaoBlackcat, FalhaConfirmacaoBlackcat, ResultadoConfirmacaoBlackcat } from "./blackcat";
import { confirmadorDeCobranca } from "./simulado";
import { duracaoDoPedido, planejarAtivacao } from "./confirmacao";
import {
  RESOLUCOES_DE_REVISAO,
  travarContaParaCobranca,
  type MotivoDeRevisao,
  type ResolucaoDeRevisao,
} from "./revisao";

/**
 * Como a operação resolve um caso de revisão.
 *
 * Três garantias, e o arquivo é organizado em torno delas:
 *
 *  1. **Nada acontece sem o provedor.** Ativar exige `PAID` com a transação e
 *     o valor do pedido; confirmar estorno exige `REFUNDED`; encerrar como não
 *     pago exige `CANCELLED` ou PIX vencido. A consulta é feita na hora — o
 *     estado local nunca basta.
 *  2. **Nada acontece duas vezes.** Cada ação carrega uma chave de idempotência
 *     única no histórico; a mesma chave devolve o registro anterior. A conta
 *     fica travada durante a transação, o caso é relido travado, e cada
 *     escrita é condicionada ao estado esperado.
 *  3. **Nenhum direito é inventado.** Não existe saldo nem crédito avulso:
 *     recompor um upgrade estornado só reativa períodos que *este* pedido
 *     cancelou e que ainda não terminaram.
 *
 * `planejarResolucao` é pura e decide tudo; `executarAcaoDeRevisao` só aplica.
 */

export const ACOES_DE_REVISAO = [
  "reconsultar",
  "ativar",
  "confirmar_estorno",
  "confirmar_nao_pago",
  "recompor_upgrade",
  "encerrar_sem_alteracao",
] as const;

export type AcaoDeRevisao = (typeof ACOES_DE_REVISAO)[number];

export type RecusaDeAcao =
  | "provedor_indisponivel"
  | "transacao_divergente"
  | "valor_divergente"
  | "pagamento_nao_confirmado"
  | "estorno_nao_confirmado"
  | "pagamento_ainda_valido"
  | "pedido_em_estado_incompativel"
  | "pedido_ja_ativado"
  | "ativacao_periodo_em_aberto"
  | "ativacao_substituicao_divergente"
  | "ativacao_duracao_invalida"
  | "ativacao_operacao_invalida"
  | "conflito_com_periodo_atual"
  | "observacao_obrigatoria";

export interface PedidoEmRevisao {
  id: string;
  userId: string;
  planoId: string;
  planoPrecoId: string;
  status: string;
  valorCentavos: number;
  transacaoId: string | null;
  expiraEm: Date | null;
  operacao: string;
  assinaturasSubstituidas: string[];
  duracaoDias: number | null;
  duracaoMeses: number | null;
  telasAdicionais: number;
  servidorVip: boolean;
}

export type Efeito =
  | { tipo: "nenhum"; registro: string }
  | { tipo: "ativar"; iniciaEm: Date; terminaEm: Date; cancelar: string[] }
  | { tipo: "estornar"; cancelarAssinaturaId: string | null }
  | { tipo: "nao_pago"; status: "CANCELADO" | "EXPIRADO" }
  | { tipo: "recompor"; restaurar: string[]; cancelarAssinaturaId: string | null };

export type PlanoDeResolucao =
  | { ok: false; codigo: RecusaDeAcao }
  | { ok: true; efeito: Efeito; resolve: ResolucaoDeRevisao | null; novoMotivo?: MotivoDeRevisao };

export const OBSERVACAO_DE_SUBSTITUICAO = (pedidoId: string) => `substituida pelo pedido ${pedidoId}`;
export const OBSERVACAO_DE_RESTAURACAO = (pedidoId: string) => `restaurada apos estorno do pedido ${pedidoId}`;
const OBSERVACAO_MINIMA = 10;

/** Decide a ação. Pura: tudo que ela sabe chega por parâmetro. */
export function planejarResolucao(e: {
  acao: AcaoDeRevisao;
  pedido: PedidoEmRevisao;
  assinaturaDoPedido: { id: string; status: string } | null;
  /** Consulta feita agora; `null` = provedor não respondeu. */
  confirmacao: ConfirmacaoBlackcat | null;
  /** Assinaturas ATIVA da conta que ainda não terminaram. */
  abertos: { id: string; terminaEm: Date }[];
  /** As linhas de `pedido.assinaturasSubstituidas`, como estão agora. */
  substituidas: { id: string; status: string; observacao: string | null; terminaEm: Date }[];
  observacao?: string | null;
  agora: Date;
}): PlanoDeResolucao {
  const { acao, pedido, confirmacao: c, agora } = e;

  if (acao === "encerrar_sem_alteracao") {
    if ((e.observacao ?? "").trim().length < OBSERVACAO_MINIMA) return { ok: false, codigo: "observacao_obrigatoria" };
    // Pedido ainda travado em REVISAO_MANUAL tem de passar por uma ação real;
    // encerrar sem alterar deixaria o pedido pendurado e sem caso.
    if (pedido.status === "REVISAO_MANUAL") return { ok: false, codigo: "pedido_em_estado_incompativel" };
    return { ok: true, efeito: { tipo: "nenhum", registro: "encerrada" }, resolve: "encerrada_sem_alteracao" };
  }

  if (!c) return { ok: false, codigo: "provedor_indisponivel" };
  if (!pedido.transacaoId || c.transactionId !== pedido.transacaoId) return { ok: false, codigo: "transacao_divergente" };

  if (acao === "reconsultar") {
    return { ok: true, efeito: { tipo: "nenhum", registro: `provedor:${c.status}` }, resolve: null };
  }

  if (acao === "ativar") {
    if (pedido.status !== "REVISAO_MANUAL") return { ok: false, codigo: "pedido_em_estado_incompativel" };
    if (e.assinaturaDoPedido) return { ok: false, codigo: "pedido_ja_ativado" };
    if (c.status !== "PAID") return { ok: false, codigo: "pagamento_nao_confirmado" };
    if (c.amount !== pedido.valorCentavos) return { ok: false, codigo: "valor_divergente" };
    const plano = planejarAtivacao(
      { operacao: pedido.operacao, assinaturasSubstituidas: pedido.assinaturasSubstituidas, duracao: duracaoDoPedido(pedido) },
      e.abertos,
      agora,
    );
    if (!plano.ok) return { ok: false, codigo: `ativacao_${plano.motivo}` as RecusaDeAcao };
    return {
      ok: true,
      efeito: { tipo: "ativar", iniciaEm: plano.iniciaEm, terminaEm: plano.terminaEm, cancelar: plano.cancelar },
      resolve: "ativada",
    };
  }

  if (acao === "confirmar_estorno") {
    if (c.status !== "REFUNDED") return { ok: false, codigo: "estorno_nao_confirmado" };
    if (c.amount !== pedido.valorCentavos) return { ok: false, codigo: "valor_divergente" };
    if (!["REVISAO_MANUAL", "PAGO", "ESTORNADO"].includes(pedido.status)) {
      return { ok: false, codigo: "pedido_em_estado_incompativel" };
    }
    const cancelarAssinaturaId = e.assinaturaDoPedido?.status === "ATIVA" ? e.assinaturaDoPedido.id : null;
    if (pedido.operacao === "upgrade") {
      // O estorno é registrado já; restaurar o que o upgrade substituiu é outra
      // ação, com as próprias verificações. O caso continua aberto.
      return { ok: true, efeito: { tipo: "estornar", cancelarAssinaturaId }, resolve: null, novoMotivo: "estorno_upgrade" };
    }
    return { ok: true, efeito: { tipo: "estornar", cancelarAssinaturaId }, resolve: "estorno_confirmado" };
  }

  if (acao === "confirmar_nao_pago") {
    if (pedido.status !== "REVISAO_MANUAL" || e.assinaturaDoPedido) {
      return { ok: false, codigo: "pedido_em_estado_incompativel" };
    }
    if (c.status === "CANCELLED") return { ok: true, efeito: { tipo: "nao_pago", status: "CANCELADO" }, resolve: "nao_pago_confirmado" };
    if (c.status === "PENDING") {
      if (!pedido.expiraEm || pedido.expiraEm > agora) return { ok: false, codigo: "pagamento_ainda_valido" };
      return { ok: true, efeito: { tipo: "nao_pago", status: "EXPIRADO" }, resolve: "nao_pago_confirmado" };
    }
    return { ok: false, codigo: "pedido_em_estado_incompativel" };
  }

  // recompor_upgrade
  if (pedido.operacao !== "upgrade" || pedido.status !== "ESTORNADO") {
    return { ok: false, codigo: "pedido_em_estado_incompativel" };
  }
  if (c.status !== "REFUNDED") return { ok: false, codigo: "estorno_nao_confirmado" };

  const cancelarAssinaturaId = e.assinaturaDoPedido?.status === "ATIVA" ? e.assinaturaDoPedido.id : null;
  // Qualquer outro período em aberto (compra posterior, cortesia) torna a
  // restauração ambígua: sobreporia períodos. Fica para decisão humana.
  const outros = e.abertos.filter((a) => a.id !== cancelarAssinaturaId);
  if (outros.length > 0) return { ok: false, codigo: "conflito_com_periodo_atual" };

  const creditadas = new Set(pedido.assinaturasSubstituidas);
  const restaurar = e.substituidas
    .filter((s) =>
      creditadas.has(s.id) &&
      s.status === "CANCELADA" &&
      s.observacao === OBSERVACAO_DE_SUBSTITUICAO(pedido.id) &&
      s.terminaEm > agora,
    )
    .map((s) => s.id);

  return {
    ok: true,
    efeito: { tipo: "recompor", restaurar, cancelarAssinaturaId },
    resolve: restaurar.length > 0 ? "upgrade_recomposto" : "upgrade_sem_periodo_restante",
  };
}

// ── Execução ─────────────────────────────────────────────────────────────────

export interface EntradaDaAcao {
  revisaoId: string;
  acao: unknown;
  chaveIdempotencia: unknown;
  observacao?: unknown;
  /** "token_admin" ou id do usuário admin. Vem da autenticação, nunca do corpo. */
  ator: string;
}

export type ResultadoDaAcao =
  | { ok: true; resultado: string; repetida: boolean; revisaoResolvida: boolean }
  | { ok: false; status: 400 | 404 | 409 | 422 | 503; codigo: string };

export interface DependenciasDaAcao {
  banco: typeof prisma;
  consultar: ((transacaoId: string) => Promise<ResultadoConfirmacaoBlackcat>) | null;
  invalidar: (userId: string) => Promise<unknown>;
  agora: () => Date;
}

const CHAVE_VALIDA = /^[A-Za-z0-9_-]{16,100}$/;

/**
 * Por que a consulta autoritativa não trouxe um status, do ponto de vista da
 * ação de revisão. `configuracao` é o caso em que o confirmador **nem existe**
 * (`lerConfiguracao` devolveu null: chave ausente, ou confirmação ativa com
 * `NEXTAUTH_URL`/segredo do webhook inválidos) — a Blackcat não chega a ser
 * consultada. Os demais vêm da própria consulta.
 */
export type FalhaDoProvedorNaRevisao = "configuracao" | FalhaConfirmacaoBlackcat;

/**
 * A regra financeira não muda: sem status do provedor, a ação é recusada e o
 * caso continua preso. O que muda é só o **diagnóstico**: em vez de colapsar
 * tudo em `provedor_indisponivel`, o código real da falha é registrado no log do
 * servidor e devolvido à rota admin como um código seguro. Nenhum destes
 * carrega dado sensível — nem transactionId, nem corpo da Blackcat.
 */
export const CODIGO_SEGURO_DO_PROVEDOR: Record<FalhaDoProvedorNaRevisao, string> = {
  configuracao: "provedor_configuracao",
  timeout: "provedor_timeout",
  rede: "provedor_rede",
  nao_encontrada: "provedor_nao_encontrado",
  recusada: "provedor_recusado",
  indisponivel: "provedor_indisponivel",
  resposta_invalida: "provedor_resposta_invalida",
};

function ehAcao(v: unknown): v is AcaoDeRevisao {
  return typeof v === "string" && (ACOES_DE_REVISAO as readonly string[]).includes(v);
}

function conflitoRetryable(erro: unknown) {
  return typeof erro === "object" && erro !== null && (erro as { code?: unknown }).code === "P2034";
}
function chaveDuplicada(erro: unknown) {
  const e = erro as { code?: unknown; meta?: { target?: unknown } };
  return e?.code === "P2002" && (
    (Array.isArray(e.meta?.target) && e.meta.target.includes("chaveIdempotencia")) ||
    e.meta?.target === "RevisaoPagamentoEvento_chaveIdempotencia_key"
  );
}

class ConflitoDeEstado extends Error {}

export async function executarAcaoDeRevisao(
  entrada: EntradaDaAcao,
  injetadas: Partial<DependenciasDaAcao> = {},
): Promise<ResultadoDaAcao> {
  const banco = injetadas.banco ?? prisma;
  const agora = (injetadas.agora ?? (() => new Date()))();
  const invalidar = injetadas.invalidar ?? invalidarEntitlements;
  const consultar = injetadas.consultar !== undefined ? injetadas.consultar : confirmadorDeCobranca();

  if (!ehAcao(entrada.acao)) return { ok: false, status: 400, codigo: "acao_invalida" };
  if (typeof entrada.chaveIdempotencia !== "string" || !CHAVE_VALIDA.test(entrada.chaveIdempotencia)) {
    return { ok: false, status: 400, codigo: "chave_invalida" };
  }
  const observacao = typeof entrada.observacao === "string" ? entrada.observacao.trim().slice(0, 500) : null;
  const acao = entrada.acao;
  const chave = entrada.chaveIdempotencia;

  // Mesma chave: devolve o que já aconteceu, sem consultar nem escrever nada.
  const anterior = await banco.revisaoPagamentoEvento.findUnique({
    where: { chaveIdempotencia: chave },
    select: { revisaoId: true, tipo: true, codigo: true },
  });
  if (anterior) {
    if (anterior.revisaoId !== entrada.revisaoId) return { ok: false, status: 409, codigo: "chave_de_outro_caso" };
    if (anterior.tipo === "acao_recusada") return { ok: false, status: 422, codigo: anterior.codigo.split(":")[1] ?? anterior.codigo };
    return { ok: true, resultado: anterior.codigo, repetida: true, revisaoResolvida: false };
  }

  const caso = await banco.revisaoPagamento.findUnique({
    where: { id: entrada.revisaoId },
    select: { id: true, status: true, pedidoId: true, pedido: { select: { userId: true, transacaoId: true } } },
  });
  if (!caso) return { ok: false, status: 404, codigo: "revisao_nao_encontrada" };
  if (caso.status !== "PENDENTE") return { ok: false, status: 409, codigo: "revisao_ja_resolvida" };

  // A consulta ao provedor fica fora da transação: rede não segura trava.
  //
  // A classificação REAL da falha é preservada em `falhaProvedor` — antes ela
  // era descartada e toda falha do provedor virava indistintamente
  // `provedor_indisponivel`, o que impedia saber se o caso estava preso por
  // configuração, timeout, 4xx, 5xx ou resposta inválida. A regra financeira
  // não muda: sem `confirmacao`, `planejarResolucao` recusa do mesmo jeito.
  let confirmacao: ConfirmacaoBlackcat | null = null;
  let falhaProvedor: FalhaDoProvedorNaRevisao | null = null;
  if (acao !== "encerrar_sem_alteracao" && caso.pedido.transacaoId) {
    if (!consultar) {
      // `confirmadorDeCobranca()` devolveu null: `lerConfiguracao` recusou a
      // configuração e a Blackcat nem chega a ser consultada.
      falhaProvedor = "configuracao";
    } else {
      const externo = await consultar(caso.pedido.transacaoId).catch(() => null);
      if (externo && externo.ok) confirmacao = externo.confirmacao;
      else if (externo) falhaProvedor = externo.falha;
      else falhaProvedor = "rede"; // consultar lançou apesar de não dever.
    }
  }

  let resposta: ResultadoDaAcao;
  let mudouDireito = false;
  try {
    resposta = await transacaoComRetry(banco, async (tx) => {
      mudouDireito = false;
      await travarContaParaCobranca(tx, caso.pedido.userId);

      const atual = await tx.revisaoPagamento.findUnique({ where: { id: caso.id }, select: { status: true, pedidoId: true } });
      if (!atual || atual.status !== "PENDENTE") return { ok: false, status: 409, codigo: "revisao_ja_resolvida" } as const;

      const pedido = await tx.pedidoPagamento.findUnique({ where: { id: atual.pedidoId }, include: { assinatura: true } });
      if (!pedido) throw new ConflitoDeEstado("pedido_ausente");

      const abertos = await tx.assinatura.findMany({
        where: { userId: pedido.userId, status: "ATIVA", terminaEm: { gt: agora } },
        select: { id: true, terminaEm: true },
      });
      const substituidas = pedido.assinaturasSubstituidas.length
        ? await tx.assinatura.findMany({
            where: { id: { in: pedido.assinaturasSubstituidas } },
            select: { id: true, status: true, observacao: true, terminaEm: true },
          })
        : [];

      const plano = planejarResolucao({
        acao, pedido, confirmacao, abertos, substituidas, observacao, agora,
        assinaturaDoPedido: pedido.assinatura ? { id: pedido.assinatura.id, status: pedido.assinatura.status } : null,
      });

      if (!plano.ok) {
        // Quando a recusa foi por falta de status do provedor, o código real
        // (configuração/timeout/rede/404/4xx/5xx/inválida) substitui o genérico
        // `provedor_indisponivel` no evento e na resposta — sem alterar o
        // desfecho financeiro nem o status HTTP (503 continua sendo 503).
        const codigoDiag = plano.codigo === "provedor_indisponivel" && falhaProvedor
          ? CODIGO_SEGURO_DO_PROVEDOR[falhaProvedor]
          : plano.codigo;
        await tx.revisaoPagamentoEvento.create({
          data: { revisaoId: caso.id, tipo: "acao_recusada", codigo: `${acao}:${codigoDiag}`, ator: entrada.ator, observacao, chaveIdempotencia: chave },
        });
        return { ok: false, status: plano.codigo === "provedor_indisponivel" ? 503 : 422, codigo: codigoDiag } as const;
      }

      const ef = plano.efeito;
      if (ef.tipo === "ativar") {
        for (const id of ef.cancelar) {
          const r = await tx.assinatura.updateMany({
            where: { id, status: "ATIVA" },
            data: { status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO(pedido.id) },
          });
          if (r.count !== 1) throw new ConflitoDeEstado("substituicao");
        }
        // `Assinatura.pedidoId` é único: uma segunda ativação do mesmo pedido falha no banco.
        await tx.assinatura.create({
          data: {
            userId: pedido.userId, planoId: pedido.planoId, planoPrecoId: pedido.planoPrecoId, pedidoId: pedido.id,
            status: "ATIVA", origem: "pagamento", iniciaEm: ef.iniciaEm, terminaEm: ef.terminaEm,
            telasAdicionais: pedido.telasAdicionais, servidorVip: pedido.servidorVip,
          },
        });
        const p = await tx.pedidoPagamento.updateMany({ where: { id: pedido.id, status: "REVISAO_MANUAL" }, data: { status: "PAGO" } });
        if (p.count !== 1) throw new ConflitoDeEstado("pedido");
        mudouDireito = true;
      } else if (ef.tipo === "estornar") {
        await tx.pedidoPagamento.update({ where: { id: pedido.id }, data: { status: "ESTORNADO" } });
        if (ef.cancelarAssinaturaId) {
          await tx.assinatura.updateMany({ where: { id: ef.cancelarAssinaturaId, status: "ATIVA" }, data: { status: "CANCELADA" } });
          mudouDireito = true;
        }
      } else if (ef.tipo === "nao_pago") {
        const p = await tx.pedidoPagamento.updateMany({ where: { id: pedido.id, status: "REVISAO_MANUAL" }, data: { status: ef.status } });
        if (p.count !== 1) throw new ConflitoDeEstado("pedido");
      } else if (ef.tipo === "recompor") {
        if (ef.cancelarAssinaturaId) {
          await tx.assinatura.updateMany({ where: { id: ef.cancelarAssinaturaId, status: "ATIVA" }, data: { status: "CANCELADA" } });
        }
        for (const id of ef.restaurar) {
          const r = await tx.assinatura.updateMany({
            where: { id, status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO(pedido.id) },
            data: { status: "ATIVA", observacao: OBSERVACAO_DE_RESTAURACAO(pedido.id) },
          });
          if (r.count !== 1) throw new ConflitoDeEstado("restauracao");
        }
        mudouDireito = ef.restaurar.length > 0 || ef.cancelarAssinaturaId !== null;
      }

      await tx.revisaoPagamentoEvento.create({
        data: {
          revisaoId: caso.id, tipo: "acao_executada",
          codigo: ef.tipo === "nenhum" ? `${acao}:${ef.registro}` : acao,
          ator: entrada.ator, observacao, chaveIdempotencia: chave,
        },
      });

      if (plano.novoMotivo) {
        await tx.revisaoPagamento.update({ where: { id: caso.id }, data: { motivo: plano.novoMotivo } });
        await tx.revisaoPagamentoEvento.create({
          data: { revisaoId: caso.id, tipo: "motivo_registrado", codigo: plano.novoMotivo, ator: entrada.ator },
        });
      }

      if (plano.resolve) {
        const r = await tx.revisaoPagamento.updateMany({
          where: { id: caso.id, status: "PENDENTE" },
          data: { status: "RESOLVIDA", resolucao: plano.resolve, resolvidaEm: agora },
        });
        if (r.count !== 1) throw new ConflitoDeEstado("caso");
        await tx.revisaoPagamentoEvento.create({
          data: { revisaoId: caso.id, tipo: "resolvida", codigo: plano.resolve, ator: entrada.ator },
        });
      }

      return { ok: true, resultado: plano.resolve ?? acao, repetida: false, revisaoResolvida: plano.resolve !== null } as const;
    });
  } catch (erro) {
    if (chaveDuplicada(erro)) {
      // Duas requisições com a mesma chave ao mesmo tempo: uma venceu, esta não fez nada.
      const vencedora = await banco.revisaoPagamentoEvento.findUnique({ where: { chaveIdempotencia: chave }, select: { codigo: true } });
      return { ok: true, resultado: vencedora?.codigo ?? acao, repetida: true, revisaoResolvida: false };
    }
    if (erro instanceof ConflitoDeEstado || (erro as { code?: unknown })?.code === "P2002") {
      return { ok: false, status: 409, codigo: "estado_mudou_tente_reconsultar" };
    }
    throw erro;
  }

  if (resposta.ok) {
    audit("billing_review_action", { userId: caso.pedido.userId, detail: `revisao ${caso.id} ${acao} -> ${resposta.resultado}` });
    if (mudouDireito) {
      try { await invalidar(caso.pedido.userId); } catch { audit("billing_entitlements_invalidation_failed", { userId: caso.pedido.userId, detail: "apos_revisao" }); }
    }
  } else {
    // Diagnóstico autoritativo, só com ids permitidos e a classificação —
    // nunca transactionId completo, chave, corpo da Blackcat, QR/copia-e-cola
    // ou dado do cliente. É o que permite descobrir por que a consulta ao
    // provedor não trouxe status sem vazar nada sensível.
    if (falhaProvedor) {
      audit("billing_review_provider_failed", {
        userId: caso.pedido.userId,
        detail: `falha=${falhaProvedor} revisao=${caso.id} pedido=${caso.pedidoId}`,
      });
    }
    audit("billing_review_action_refused", { userId: caso.pedido.userId, detail: `revisao ${caso.id} ${acao}: ${resposta.codigo}` });
  }
  return resposta;
}

const MAX_TENTATIVAS = 3;
async function transacaoComRetry<T>(
  banco: typeof prisma,
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  let ultimo: unknown;
  for (let t = 0; t < MAX_TENTATIVAS; t++) {
    try {
      return await banco.$transaction(fn, { isolationLevel: "Serializable" });
    } catch (erro) {
      ultimo = erro;
      if (!conflitoRetryable(erro) || t === MAX_TENTATIVAS - 1) throw erro;
    }
  }
  throw ultimo;
}

export function descricaoDaResolucao(codigo: string | null): string | null {
  return codigo && Object.prototype.hasOwnProperty.call(RESOLUCOES_DE_REVISAO, codigo)
    ? RESOLUCOES_DE_REVISAO[codigo as ResolucaoDeRevisao]
    : null;
}
