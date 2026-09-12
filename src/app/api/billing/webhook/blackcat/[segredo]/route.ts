import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/auditLog";
import { checkRateLimit, clientIp, readJsonBody } from "@/lib/requestSecurity";
import { confirmarPedidoPorId } from "@/lib/billing/confirmacao";

export const dynamic = "force-dynamic";
const OK = () => NextResponse.json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });

/** Aviso não autenticado: só registra campos documentados e pede confirmação S2S. */
function createWebhookBlackcatHandler(deps:any={}) { const banco=deps.prisma??prisma, limitar=deps.checkRateLimit??checkRateLimit, ip=deps.clientIp??clientIp, ler=deps.readJsonBody??readJsonBody, confirmar=deps.confirmarPedidoPorId??confirmarPedidoPorId, env=deps.env??process.env; return async function POST(req: NextRequest, { params }: { params: { segredo: string } }) {
  const segredo = env.BLACKCAT_WEBHOOK_PATH_SECRET;
  if (env.BLACKCAT_CONFIRMACAO_ATIVA !== "true" || !segredo || params.segredo !== segredo) return new NextResponse(null, { status: 404 });
  try { const limite = await limitar(`billing:webhook:${ip(req)}`, 30, 60); if (!limite.allowed) return OK(); } catch { return OK(); }
  if (req.headers.get("x-webhook-source") !== "blackcat-api") return OK();
  const evento = req.headers.get("x-webhook-event");
  let body: unknown; try { body = await ler(req, 8 * 1024); } catch { return OK(); }
  if (!evento || !body || typeof body !== "object") return OK();
  const b = body as Record<string, unknown>;
  const transactionId = typeof b.transactionId === "string" ? b.transactionId.trim() : "";
  const status = typeof b.status === "string" ? b.status : "";
  if (!transactionId || !status || !["transaction.created", "transaction.paid", "transaction.failed"].includes(evento)) return OK();
  const pedido = await banco.pedidoPagamento.findUnique({ where: { transacaoId: transactionId }, select: { id: true, userId: true } });
  try {
    await banco.eventoPagamento.create({ data: { provedor: "blackcat", transacaoId: transactionId, evento, statusInformado: status, pedidoId: pedido?.id, resultado: pedido ? "recebido" : "desconhecido" } });
  } catch { return OK(); } // unique: duplicado é sucesso idempotente
  audit("billing_webhook_received", { userId: pedido?.userId, detail: pedido ? `pedido ${pedido.id}` : "transacao desconhecida" });
  // Next 14 não oferece um pós-response confiável: aguarda a confirmação curta.
  // Falha transitória é registrada pelo serviço e deixa o pedido para polling/cron.
  if (pedido) await confirmar(pedido.id).catch(() => {});
  return OK();
}; }
export const POST=Object.assign(createWebhookBlackcatHandler(), { createForTest: createWebhookBlackcatHandler });
