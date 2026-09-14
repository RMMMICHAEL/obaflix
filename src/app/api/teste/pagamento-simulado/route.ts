import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { readJsonBody } from "@/lib/requestSecurity";
import { audit } from "@/lib/auditLog";
import { STATUS_SIMULAVEIS, definirStatusSimulado, simulacaoDePagamentoAtiva } from "@/lib/billing/simulado";
import type { StatusBlackcat } from "@/lib/billing/blackcat";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
const naoEncontrado = () => NextResponse.json({ error: "Não encontrado" }, { status: 404, headers: NO_STORE });

/**
 * `POST /api/teste/pagamento-simulado` — só no ambiente isolado de testes.
 *
 * Muda o estado de uma venda simulada: `{ transacaoId, status, valorCentavos? }`.
 * Não concede nada sozinha: a mudança só vale depois que a confirmação normal
 * (polling, webhook, reconciliação ou ação de revisão) consultar o "provedor".
 *
 * Fora do ambiente de teste, ou sem o token correto, responde 404 — a rota não
 * se anuncia.
 */
function createPagamentoSimuladoHandler(deps: any = {}) {
  const env = deps.env ?? process.env;
  const redis = deps.redis ?? null;
  const agora = deps.agora ?? (() => new Date());
  return async function POST(req: NextRequest) {
    if (!simulacaoDePagamentoAtiva(env)) return naoEncontrado();

    const esperado = env.TESTE_PAGAMENTO_TOKEN ?? "";
    const recebido = req.headers.get("x-teste-token") ?? "";
    const valido = esperado.length >= 32 && recebido.length === esperado.length &&
      crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado));
    if (!valido) return naoEncontrado();

    let corpo: { transacaoId?: unknown; status?: unknown; valorCentavos?: unknown };
    try { corpo = await readJsonBody(req, 512); } catch { return NextResponse.json({ codigo: "parametros_invalidos" }, { status: 400, headers: NO_STORE }); }

    const transacaoId = typeof corpo?.transacaoId === "string" && /^sim_[a-f0-9]{24}$/.test(corpo.transacaoId) ? corpo.transacaoId : null;
    const status = typeof corpo?.status === "string" && (STATUS_SIMULAVEIS as readonly string[]).includes(corpo.status) ? (corpo.status as StatusBlackcat) : null;
    if (!transacaoId || !status) return NextResponse.json({ codigo: "parametros_invalidos" }, { status: 400, headers: NO_STORE });

    const ok = await definirStatusSimulado(redis ?? getRedis(), transacaoId, status, typeof corpo.valorCentavos === "number" ? corpo.valorCentavos : undefined, agora());
    if (!ok) return naoEncontrado();

    audit("billing_webhook_received", { detail: `pagamento simulado ${status}` });
    return NextResponse.json({ ok: true, transacaoId, status }, { headers: NO_STORE });
  };
}

export const POST = Object.assign(createPagamentoSimuladoHandler(), { createForTest: createPagamentoSimuladoHandler });
