/**
 * Exclusão de conta — a decisão e a ordem, separadas da rota.
 *
 * O módulo do App Router só exporta o verbo HTTP; nada deixado lá é alcançável
 * por teste. Por isso as três coisas que importam vivem aqui, como funções que
 * os testes exercitam de verdade, sem `NextRequest` e sem banco:
 *
 *   1. quem pode pedir a exclusão (`sessaoPodeExcluir`, `papelPodeExcluir`);
 *   2. o que conta como confirmação forte (`confirmacaoValida`);
 *   3. em que ordem as linhas saem do banco (`excluirDadosDaConta`), que é a
 *      parte onde um engano apaga a coisa errada ou é recusado pelo Postgres.
 *
 * A rota faz só o que é HTTP: origem, sessão, IP, limite, tamanho do corpo — e
 * entrega a decisão e a transação para cá.
 */

import type { Prisma } from "@prisma/client";
import type { UsuarioRequisicao } from "@/lib/authSession";

/** A única palavra aceita no corpo. Igualdade exata, sem normalizar. */
export const CONFIRMACAO_ESPERADA = "EXCLUIR";

/** O papel que nunca pode se autoexcluir. Mesmo valor de `auth.ts`/middleware. */
export const PAPEL_ADMIN = "admin";

export type RecusaDeExclusao = {
  ok: false;
  /** 401 quando não há conta humana; 403 quando há, mas não pode excluir. */
  status: 401 | 403;
  /** Código técnico para o log. Nunca vai para a resposta ao cliente. */
  codigo: string;
};

export type DecisaoDeExclusao = { ok: true } | RecusaDeExclusao;

/**
 * Checagem que não precisa do banco: a exclusão exige sessão humana.
 *
 * Sem credencial → 401. Credencial de TV/dispositivo (`Bearer`) → 403, sempre:
 * um aparelho pareado não apaga a conta de quem o pareou. Só a sessão de
 * cookie (site, Electron, app móvel) chega ao segundo portão.
 */
export function sessaoPodeExcluir(
  usuario: UsuarioRequisicao | null,
): DecisaoDeExclusao {
  if (!usuario) return { ok: false, status: 401, codigo: "sem_sessao" };
  if (usuario.origem !== "cookie") {
    return { ok: false, status: 403, codigo: "origem_nao_humana" };
  }
  return { ok: true };
}

/**
 * Segundo portão, com o papel lido do **banco** — nunca do JWT, que pode estar
 * desatualizado (um admin rebaixado continuaria com `role=admin` no token).
 *
 * `null` é a conta que já não existe: o token decodifica, mas a linha sumiu.
 * Trata-se como 401, não 500 — não há nada para excluir.
 */
export function papelPodeExcluir(roleNoBanco: string | null): DecisaoDeExclusao {
  if (roleNoBanco === null) return { ok: false, status: 401, codigo: "conta_inexistente" };
  if (roleNoBanco === PAPEL_ADMIN) {
    return { ok: false, status: 403, codigo: "admin_nao_pode_excluir" };
  }
  return { ok: true };
}

/**
 * O corpo aceito é exatamente `{ "confirmacao": "EXCLUIR" }` e nada mais útil.
 * Qualquer outra coisa — ausente, minúscula, espaço em volta, outro tipo — é
 * recusa. A igualdade é estrita de propósito: "excluir" ou " EXCLUIR " não
 * valem, porque a UI pede a palavra em caixa alta e o acordo é literal.
 */
export function confirmacaoValida(corpo: unknown): boolean {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return false;
  return (corpo as Record<string, unknown>).confirmacao === CONFIRMACAO_ESPERADA;
}

/** Quantas linhas saíram de cada tabela. Para o resumo técnico, nunca PII. */
export interface ResumoExclusao {
  watchHistory: number;
  watchlist: number;
  likes: number;
  tvRefreshTokens: number;
  tvDevices: number;
  revisaoEventos: number;
  revisoes: number;
  eventosPagamento: number;
  assinaturas: number;
  pedidos: number;
}

/**
 * Apaga tudo que pertence à conta e, por último, a própria conta.
 *
 * ## A ordem é carga, não estilo
 *
 * O schema real impõe boa parte dela com `ON DELETE NO ACTION` — apagar o pai
 * antes do filho é **recusado pelo Postgres**, não ignorado:
 *
 *   - `RevisaoPagamentoEvento → RevisaoPagamento` (NO ACTION): evento antes do caso;
 *   - `RevisaoPagamento → PedidoPagamento`       (NO ACTION): caso antes do pedido;
 *   - `Assinatura.pedidoId → PedidoPagamento`    (NO ACTION): assinatura antes do pedido;
 *   - `EventoPagamento → PedidoPagamento`        (SET NULL): apagado explicitamente
 *     para não deixar evento órfão com `pedidoId = null`.
 *
 * `TvRefreshToken → TvDevice` e `TvDevice/Assinatura/PedidoPagamento → User` são
 * CASCADE no banco; mesmo assim apagamos explícito, na ordem, em vez de confiar
 * na cascata disparada por `User.delete`: a cascata e as FKs NO ACTION acima
 * conviveriam na mesma transação, e a ordem de uma cascata não é contrato.
 *
 * `AdminAudit.adminUserId → User` é **ON DELETE SET NULL** (PR #74) e **não é
 * tocado aqui**: é registro imutável de ação administrativa. Esta rota só exclui
 * contas `role != admin`, que em regra não são autoras de auditoria; o caso do
 * ex-admin rebaixado (que tem linha lá) agora resolve-se sozinho — `User.delete`
 * desvincula o ator (`adminUserId` vira `null`) sem apagar a auditoria e sem
 * derrubar a transação. Antes da PR #74 a FK era NO ACTION e esse `User.delete`
 * falharia, revertendo tudo; esse blocker foi resolvido estruturalmente.
 *
 * `RevisaoPagamento.userId` é coluna escalar (sem FK), por isso o filtro é
 * direto; `RevisaoPagamentoEvento` e `EventoPagamento` não têm `userId` e são
 * alcançados pela relação com o caso e com o pedido.
 *
 * A PII da conta — e-mail, nome, `senhaHash`, avatar — está na linha `User`, que
 * sai por último. Não há soft-delete: ao fim, a conta não existe.
 */
export async function excluirDadosDaConta(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<ResumoExclusao> {
  // Conteúdo e preferências pessoais.
  const watchHistory = (await tx.watchHistory.deleteMany({ where: { userId } })).count;
  const watchlist = (await tx.watchlist.deleteMany({ where: { userId } })).count;
  const likes = (await tx.like.deleteMany({ where: { userId } })).count;

  // Dispositivos de TV: token (filho) antes do aparelho (pai).
  const tvRefreshTokens = (await tx.tvRefreshToken.deleteMany({ where: { device: { userId } } })).count;
  const tvDevices = (await tx.tvDevice.deleteMany({ where: { userId } })).count;

  // Cobrança, de baixo para cima na cadeia de FKs NO ACTION.
  const revisaoEventos = (await tx.revisaoPagamentoEvento.deleteMany({ where: { revisao: { userId } } })).count;
  const revisoes = (await tx.revisaoPagamento.deleteMany({ where: { userId } })).count;
  const eventosPagamento = (await tx.eventoPagamento.deleteMany({ where: { pedido: { userId } } })).count;
  const assinaturas = (await tx.assinatura.deleteMany({ where: { userId } })).count;
  const pedidos = (await tx.pedidoPagamento.deleteMany({ where: { userId } })).count;

  // A conta, por último. É aqui que a PII desaparece.
  await tx.user.delete({ where: { id: userId } });

  return {
    watchHistory,
    watchlist,
    likes,
    tvRefreshTokens,
    tvDevices,
    revisaoEventos,
    revisoes,
    eventosPagamento,
    assinaturas,
    pedidos,
  };
}
