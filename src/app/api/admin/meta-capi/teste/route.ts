import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { audit } from "@/lib/auditLog";
import { enviarEventoTesteMeta, TEST_EVENT_CODE_VALIDO } from "@/lib/metaCapi";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/**
 * `POST /api/admin/meta-capi/teste` — corpo `{ testEventCode }` (o código do Gerenciador de Eventos,
 * digitado a cada teste; não fica salvo). Envia um PageView sintético só ao painel "Testar eventos".
 * Nunca gera Purchase, Pix nem pedido. Só sessão admin; o token não sai do servidor.
 */
function criarHandler(deps: { requireAdmin?: typeof requireAdmin; enviar?: typeof enviarEventoTesteMeta } = {}) {
  const autorizar = deps.requireAdmin ?? requireAdmin;
  const enviar = deps.enviar ?? enviarEventoTesteMeta;
  return async function POST(req: NextRequest) {
    const negado = await autorizar(req);
    if (negado) return negado;
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && !headerMatchesHost(origin, host)) {
      return NextResponse.json({ error: "Acesso negado", codigo: "origem_invalida" }, { status: 403, headers: NO_STORE });
    }
    let corpo: { testEventCode?: unknown };
    try { corpo = await readJsonBody(req, 512); } catch {
      return NextResponse.json({ error: "Parâmetros inválidos", codigo: "parametros_invalidos" }, { status: 400, headers: NO_STORE });
    }
    const codigo = corpo?.testEventCode;
    if (typeof codigo !== "string" || !TEST_EVENT_CODE_VALIDO.test(codigo)) {
      return NextResponse.json({ error: "Informe o código de teste", codigo: "codigo_de_teste_invalido" }, { status: 400, headers: NO_STORE });
    }
    const r = await enviar(codigo);
    audit("meta_capi_teste", { detail: r.ok ? "ok" : r.motivo });
    if (!r.ok) return NextResponse.json({ ok: false, codigo: r.motivo }, { status: r.motivo === "configuracao" ? 503 : 502, headers: NO_STORE });
    return NextResponse.json({ ok: true, recebidos: r.recebidos }, { headers: NO_STORE });
  };
}

export const POST = Object.assign(criarHandler(), { createForTest: criarHandler });
