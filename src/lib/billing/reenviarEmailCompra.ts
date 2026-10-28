import { prisma } from "@/lib/prisma";
import { ehPlanoCortes } from "../planos";
import { notificarPrimeiroAcesso } from "../primeiroAcesso";

/** Uso operacional: reenvia só um recibo já pago, sem consultar gateway ou alterar assinatura. */
export async function reenviarEmailCompra(pedidoId: string, deps: {
  banco?: Pick<typeof prisma, "pedidoPagamento">;
  notificar?: typeof notificarPrimeiroAcesso;
} = {}) {
  const p = await (deps.banco ?? prisma).pedidoPagamento.findUnique({ where: { id: pedidoId }, select: {
    id: true, status: true, userId: true, planoId: true, planoPrecoId: true, valorCentavos: true, moeda: true,
    user: { select: { email: true, senhaHash: true, googleSub: true } },
    plano: { select: { nome: true, cortesNivel: true } },
    assinatura: { select: { pedidoId: true, userId: true, planoId: true, planoPrecoId: true, iniciaEm: true, terminaEm: true } },
  } });
  const a = p?.assinatura;
  if (!p || p.status !== "PAGO" || !p.user || !p.userId || !a || a.pedidoId !== p.id || a.userId !== p.userId || a.planoId !== p.planoId || a.planoPrecoId !== p.planoPrecoId || !ehPlanoCortes(p.plano.cortesNivel)) {
    return { ok: false as const, motivo: "pedido_nao_confirmado" };
  }
  return (deps.notificar ?? notificarPrimeiroAcesso)({ userId: p.userId, email: p.user.email, semSenha: !p.user.senhaHash && !p.user.googleSub,
    compra: { pedidoId: p.id, plano: p.plano.nome, valorCentavos: p.valorCentavos, moeda: p.moeda, iniciaEm: a.iniciaEm, terminaEm: a.terminaEm },
  });
}
