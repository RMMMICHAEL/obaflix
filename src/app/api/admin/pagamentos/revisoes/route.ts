import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { MOTIVOS_DE_REVISAO, mascararTransacao } from "@/lib/billing/revisao";
import { descricaoDaResolucao } from "@/lib/billing/revisaoAcoes";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
const LIMITE_MAXIMO = 100;

/**
 * `GET /api/admin/pagamentos/revisoes` — casos de revisão de pagamento.
 *
 * Mesma autenticação das demais rotas admin (`requireAdmin`: sessão com papel
 * admin ou `x-admin-token`). Devolve pedido, motivo, valores, tempo em revisão
 * e histórico. A transação aparece mascarada; nenhum dado do pagador sai daqui.
 *
 * `?status=PENDENTE` (padrão) ou `RESOLVIDA`; `?limite=` até 100.
 */
function createListarRevisoesHandler(deps: any = {}) {
  const banco = deps.prisma ?? prisma;
  const autorizar = deps.requireAdmin ?? requireAdmin;
  const agora = deps.agora ?? (() => new Date());
  return async function GET(req: NextRequest) {
    const negado = await autorizar(req);
    if (negado) return negado;

    const url = new URL(req.url);
    const status = url.searchParams.get("status") === "RESOLVIDA" ? "RESOLVIDA" : "PENDENTE";
    const limite = Math.min(Math.max(Number.parseInt(url.searchParams.get("limite") ?? "50", 10) || 50, 1), LIMITE_MAXIMO);

    const casos = await banco.revisaoPagamento.findMany({
      where: { status },
      orderBy: { abertaEm: "asc" },
      take: limite,
      select: {
        id: true, userId: true, motivo: true, status: true, resolucao: true, abertaEm: true, resolvidaEm: true,
        pedido: {
          select: {
            id: true, status: true, operacao: true, valorCentavos: true, valorPlanoCentavos: true,
            valorAdicionaisCentavos: true, creditoCentavos: true, moeda: true, transacaoId: true,
            criadoEm: true, expiraEm: true,
          },
        },
        eventos: { orderBy: { criadoEm: "asc" }, select: { tipo: true, codigo: true, ator: true, observacao: true, criadoEm: true } },
      },
    });

    const instante = agora().getTime();
    return NextResponse.json(
      {
        status,
        casos: casos.map((c: any) => ({
          revisaoId: c.id,
          userId: c.userId,
          motivo: c.motivo,
          motivoDescricao: (MOTIVOS_DE_REVISAO as Record<string, string>)[c.motivo] ?? null,
          resolucao: c.resolucao,
          resolucaoDescricao: descricaoDaResolucao(c.resolucao),
          abertaEm: c.abertaEm,
          resolvidaEm: c.resolvidaEm,
          tempoEmRevisaoSegundos: Math.max(0, Math.floor(((c.resolvidaEm?.getTime() ?? instante) - c.abertaEm.getTime()) / 1000)),
          pedido: {
            id: c.pedido.id,
            status: c.pedido.status,
            operacao: c.pedido.operacao,
            valorCentavos: c.pedido.valorCentavos,
            valorPlanoCentavos: c.pedido.valorPlanoCentavos,
            valorAdicionaisCentavos: c.pedido.valorAdicionaisCentavos,
            creditoCentavos: c.pedido.creditoCentavos,
            moeda: c.pedido.moeda,
            transacao: mascararTransacao(c.pedido.transacaoId),
            criadoEm: c.pedido.criadoEm,
            expiraEm: c.pedido.expiraEm,
          },
          historico: c.eventos,
        })),
      },
      { headers: NO_STORE },
    );
  };
}

export const GET = Object.assign(createListarRevisoesHandler(), { createForTest: createListarRevisoesHandler });
