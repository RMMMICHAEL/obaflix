import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, requireAdmin } from "@/lib/auth";
import { headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { executarAcaoDeRevisao } from "@/lib/billing/revisaoAcoes";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/**
 * `POST /api/admin/pagamentos/revisoes/:id` — executa uma ação sobre um caso.
 *
 * Corpo: `{ acao, chaveIdempotencia, observacao? }`.
 *
 * - `acao`: `reconsultar` | `ativar` | `confirmar_estorno` | `confirmar_nao_pago`
 *   | `recompor_upgrade` | `encerrar_sem_alteracao`;
 * - `chaveIdempotencia`: 16–100 caracteres `[A-Za-z0-9_-]`, gerada pelo
 *   operador por ação. Repetir a mesma chave não executa de novo;
 * - `observacao`: obrigatória em `encerrar_sem_alteracao`. Sem dado de pagador.
 *
 * Quem executou vem da autenticação, nunca do corpo.
 */
function createAcaoRevisaoHandler(deps: any = {}) {
  const autorizar = deps.requireAdmin ?? requireAdmin;
  const sessao = deps.getServerSession ?? (() => getServerSession(authOptions));
  const executar = deps.executarAcaoDeRevisao ?? executarAcaoDeRevisao;
  return async function POST(req: NextRequest, { params }: { params: { id: string } }) {
    const negado = await autorizar(req);
    if (negado) return negado;

    // Mutação por cookie vinda de navegador: a origem precisa ser a do site.
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && !req.headers.get("x-admin-token") && !headerMatchesHost(origin, host)) {
      return NextResponse.json({ error: "Acesso negado", codigo: "origem_invalida" }, { status: 403, headers: NO_STORE });
    }

    let corpo: { acao?: unknown; chaveIdempotencia?: unknown; observacao?: unknown };
    try {
      corpo = await readJsonBody(req, 2048);
    } catch {
      return NextResponse.json({ error: "Parâmetros inválidos", codigo: "parametros_invalidos" }, { status: 400, headers: NO_STORE });
    }
    if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
      return NextResponse.json({ error: "Parâmetros inválidos", codigo: "parametros_invalidos" }, { status: 400, headers: NO_STORE });
    }

    let ator = "token_admin";
    if (!req.headers.get("x-admin-token")) {
      const s = await sessao();
      ator = (s?.user as { id?: string } | undefined)?.id ?? "admin";
    }

    const r = await executar({
      revisaoId: params.id,
      acao: corpo.acao,
      chaveIdempotencia: corpo.chaveIdempotencia,
      observacao: corpo.observacao,
      ator,
    });

    if (!r.ok) return NextResponse.json({ error: "Ação não executada", codigo: r.codigo }, { status: r.status, headers: NO_STORE });
    return NextResponse.json(r, { headers: NO_STORE });
  };
}

export const POST = Object.assign(createAcaoRevisaoHandler(), { createForTest: createAcaoRevisaoHandler });
