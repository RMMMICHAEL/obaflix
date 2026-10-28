import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { confirmarPedidoPorId } from "@/lib/billing/confirmacao";
import { identificadorComercial } from "@/lib/billing/pagador";
import { consultaVisitanteValida } from "@/lib/billing/statusVisitante";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const HEADERS = { "Cache-Control": "no-store, private" };
const negado = () => NextResponse.json({ codigo: "consulta_indisponivel" }, { status: 403, headers: HEADERS });

/** Apenas quem recebeu o token na criação do seu pedido pode consultar o estado. */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin"), host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) return negado();
  try {
    const limite = await checkRateLimit(`billing:guest-status:ip:${clientIp(req)}`, 30, 60);
    if (!limite.allowed) return NextResponse.json({ codigo: "muitas_tentativas" }, { status: 429, headers: HEADERS });
  } catch { return negado(); }
  let corpo: { pedidoId?: unknown; token?: unknown };
  try { corpo = await readJsonBody<{ pedidoId?: unknown; token?: unknown }>(req, 1024); } catch { return negado(); }
  const id = identificadorComercial(corpo?.pedidoId);
  if (!id || !consultaVisitanteValida(id, corpo?.token)) return negado();
  // O pedido nasce sem userId, mas a confirmacao vincula a conta ao pagar.
  // A credencial HMAC continua especifica deste pedido e so existe em compras visitantes.
  const pedido = await prisma.pedidoPagamento.findFirst({
    where: { id, provedor: "cakto", emailComprador: { not: null } },
    select: { id: true, status: true, transacaoId: true },
  });
  if (!pedido) return negado();
  if (pedido.status === "AGUARDANDO" && pedido.transacaoId) {
    try {
      const limite = await checkRateLimit(`billing:guest-status:order:${pedido.id}`, 6, 60);
      if (limite.allowed) await confirmarPedidoPorId(pedido.id);
    } catch { /* O webhook e a conciliação continuarão responsáveis pela confirmação. */ }
  }
  const atualizado = await prisma.pedidoPagamento.findUnique({ where: { id }, select: { status: true } });
  return NextResponse.json({ status: atualizado?.status ?? pedido.status }, { headers: HEADERS });
}
