import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recordAdminAudit, requireAdminAction } from "@/lib/admin-action";
import { readJsonBody } from "@/lib/requestSecurity";

export const dynamic = "force-dynamic";

/**
 * Ações de suporte sobre o DIREITO (Assinatura). Nunca toca em
 * PedidoPagamento: pagamento não é simulado nem editado por aqui.
 *
 * Transições permitidas (as mesmas que o billing já reconhece):
 *   - suspender: ATIVA → SUSPENSA
 *   - cancelar:  ATIVA | SUSPENSA → CANCELADA
 *   - reativar:  SUSPENSA → ATIVA, só dentro da vigência
 *   - conceder:  cria cortesia `origem="admin"` só se a conta não tiver
 *                assinatura ATIVA vigente (não empilha direito)
 *
 * CANCELADA é terminal: o billing usa CANCELADA + `observacao` como marca de
 * substituição por upgrade (revisaoAcoes). Por isso `observacao` também não é
 * sobrescrita aqui: o motivo do suporte vai para AdminAudit.
 */
const TRANSICOES: Record<string, { de: string[]; para: string; acaoAudit: string }> = {
  suspender: { de: ["ATIVA"], para: "SUSPENSA", acaoAudit: "SUBSCRIPTION_SUSPENDED" },
  cancelar: { de: ["ATIVA", "SUSPENSA"], para: "CANCELADA", acaoAudit: "SUBSCRIPTION_CANCELLED" },
  reativar: { de: ["SUSPENSA"], para: "ATIVA", acaoAudit: "SUBSCRIPTION_REACTIVATED" },
};

export async function POST(req: NextRequest) {
  const auth = await requireAdminAction(req, "subscription-support"); if (auth.response) return auth.response;
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 4096);
  } catch {
    return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
  }
  const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 5) return NextResponse.json({ error: "Motivo obrigatório (mínimo 5 caracteres)" }, { status: 400 });
  const agora = new Date();

  if (body.acao === "conceder") {
    const dias = Math.floor(Number(body.dias));
    if (typeof body.userId !== "string" || typeof body.planoId !== "string" || !(dias >= 1 && dias <= 365)) {
      return NextResponse.json({ error: "Usuário, plano e duração de 1 a 365 dias são obrigatórios" }, { status: 400 });
    }
    const [user, plano, vigente] = await Promise.all([
      prisma.user.findUnique({ where: { id: body.userId }, select: { id: true } }),
      prisma.plano.findFirst({ where: { id: body.planoId, ativo: true }, select: { id: true } }),
      prisma.assinatura.findFirst({ where: { userId: body.userId, status: "ATIVA", terminaEm: { gt: agora } }, select: { id: true } }),
    ]);
    if (!user || !plano) return NextResponse.json({ error: "Usuário ou plano inválido" }, { status: 404 });
    if (vigente) return NextResponse.json({ error: "A conta já tem assinatura ativa; use o fluxo de billing" }, { status: 409 });
    const terminaEm = new Date(agora.getTime() + dias * 86400000);
    const assinatura = await prisma.assinatura.create({ data: { userId: user.id, planoId: plano.id, status: "ATIVA", origem: "admin", iniciaEm: agora, terminaEm } });
    await recordAdminAudit({ adminUserId: auth.adminUserId!, action: "SUBSCRIPTION_GRANTED", targetType: "Assinatura", targetId: assinatura.id, reason: motivo, metadata: { userId: user.id, planoId: plano.id, dias } });
    return NextResponse.json({ ok: true, id: assinatura.id });
  }

  const transicao = typeof body.acao === "string" ? TRANSICOES[body.acao] : undefined;
  if (!transicao) return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  if (typeof body.assinaturaId !== "string") return NextResponse.json({ error: "Assinatura obrigatória" }, { status: 400 });

  const assinatura = await prisma.assinatura.findUnique({ where: { id: body.assinaturaId }, select: { id: true, userId: true, status: true, terminaEm: true } });
  if (!assinatura) return NextResponse.json({ error: "Assinatura não encontrada" }, { status: 404 });
  if (!transicao.de.includes(assinatura.status)) {
    return NextResponse.json({ error: `Transição ${assinatura.status} → ${transicao.para} não permitida` }, { status: 422 });
  }
  if (transicao.para === "ATIVA" && assinatura.terminaEm <= agora) {
    return NextResponse.json({ error: "Assinatura vencida não pode ser reativada" }, { status: 422 });
  }
  // Guarda de concorrência: só muda se o status ainda for o lido acima.
  const { count } = await prisma.assinatura.updateMany({ where: { id: assinatura.id, status: assinatura.status }, data: { status: transicao.para } });
  if (count === 0) return NextResponse.json({ error: "Assinatura alterada por outro processo; recarregue" }, { status: 409 });
  await recordAdminAudit({
    adminUserId: auth.adminUserId!,
    action: transicao.acaoAudit,
    targetType: "Assinatura",
    targetId: assinatura.id,
    reason: motivo,
    metadata: { userId: assinatura.userId, statusAnterior: assinatura.status, statusNovo: transicao.para },
  });
  return NextResponse.json({ ok: true });
}
