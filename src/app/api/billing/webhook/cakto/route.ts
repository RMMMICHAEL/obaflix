import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/auditLog";
import { confirmarPedidoPorId } from "@/lib/billing/confirmacao";
import { assinaturaWebhookValida } from "@/lib/billing/cakto";

export const dynamic = "force-dynamic";
const OK = () => NextResponse.json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
const LIMITE_CORPO = 64 * 1024;
/** Eventos que mudam o direito; todos passam pela consulta autenticada antes de qualquer efeito. */
const EVENTOS_DE_PEDIDO = ["purchase_approved", "refund", "chargeback"];

/**
 * Webhook Cakto. Autenticado só pelos headers (X-Cakto-Timestamp + X-Cakto-Signature
 * sobre os bytes crus); o campo `secret` do corpo é ignorado. Nunca concede direito:
 * registra o aviso (deduplicado) e chama `confirmarPedidoPorId`, que consulta
 * `GET /orders/{id}/` na Cakto. Sem CAKTO_WEBHOOK_SECRET a rota não existe (404).
 */
function createWebhookCaktoHandler(deps: any = {}) {
  const banco = deps.prisma ?? prisma, confirmar = deps.confirmarPedidoPorId ?? confirmarPedidoPorId, env = deps.env ?? process.env, agora = deps.agora ?? Date.now;
  return async function POST(req: NextRequest) {
    const segredo = env.CAKTO_WEBHOOK_SECRET;
    if (!segredo) return new NextResponse(null, { status: 404 });
    const tamanho = Number(req.headers.get("content-length") ?? 0);
    if (tamanho > LIMITE_CORPO) return new NextResponse(null, { status: 413 });
    const corpo = Buffer.from(await req.arrayBuffer());
    if (corpo.length > LIMITE_CORPO) return new NextResponse(null, { status: 413 });
    if (!assinaturaWebhookValida(segredo, req.headers.get("x-cakto-timestamp"), req.headers.get("x-cakto-signature"), corpo, agora())) {
      audit("auth_failure", { detail: "webhook cakto assinatura invalida" });
      return new NextResponse(null, { status: 401 });
    }
    let payload: any;
    try { payload = JSON.parse(corpo.toString("utf8")); } catch { return OK(); }
    const evento = typeof payload?.event === "string" ? payload.event : "";
    // Webhook V2 manda `data` como lista.
    const itens = Array.isArray(payload?.data) ? payload.data : [payload?.data];
    for (const dado of itens) {
      const id = typeof dado?.id === "string" ? dado.id.trim() : "";
      if (!id || !EVENTOS_DE_PEDIDO.includes(evento)) continue;
      const status = typeof dado?.status === "string" ? dado.status.slice(0, 40) : "-";
      const pedido = await banco.pedidoPagamento.findFirst({ where: { provedor: "cakto", transacaoId: id }, select: { id: true, userId: true } });
      try {
        await banco.eventoPagamento.create({ data: { provedor: "cakto", transacaoId: id, evento, statusInformado: status, pedidoId: pedido?.id, resultado: pedido ? "recebido" : "desconhecido" } });
      } catch { continue; } // unique (provedor, transacaoId, evento, status): reenvio já registrado
      audit("billing_webhook_received", { userId: pedido?.userId, detail: pedido ? `cakto ${evento} pedido ${pedido.id}` : `cakto ${evento} pedido desconhecido` });
      // A consulta autenticada decide; falha transitória fica para polling/cron.
      if (pedido) await confirmar(pedido.id).catch(() => {});
    }
    return OK();
  };
}
export const POST = Object.assign(createWebhookCaktoHandler(), { createForTest: createWebhookCaktoHandler });
