import assert from "node:assert/strict";
import test from "node:test";
import { confirmarPedidoPorId } from "../billing/confirmacao";
import { criarFake, pedido } from "./helpers/billingConfirmacaoFake";

const cakto = (over: any = {}) => ({ ...pedido(), provedor: "cakto", planoId: "cortes-start", valorCentavos: 2700, plano: { cortesNivel: "individual", nome: "Start" }, metaRastreioCapturadoEm: new Date("2026-10-29"), metaFbp: "fb.1.1700000000000.1234567890", metaFbc: null, metaUserAgent: "Mozilla/5.0 (Teste)", metaPurchaseEnviadoEm: null, ...over });

async function confirmar(f: any, o: { status?: string; meta?: any; avisar?: any } = {}) {
  const enviados: any[] = [];
  const antes = process.env.BLACKCAT_CONFIRMACAO_ATIVA; process.env.BLACKCAT_CONFIRMACAO_ATIVA = "true";
  try {
    await confirmarPedidoPorId("p", {
      prisma: f.banco,
      consultarStatusBlackcat: async () => ({ ok: true, confirmacao: { transactionId: "tx", status: o.status ?? "PAID", amount: 2700, paidAt: null } }) as any,
      invalidarEntitlements: f.invalidar, agora: f.agora,
      notificarPrimeiroAcesso: o.avisar ?? (async () => {}),
      enviarPurchaseMeta: o.meta ?? (async (c: any) => { enviados.push(c); return { ok: true as const, recebidos: 1 }; }),
    });
  } finally { process.env.BLACKCAT_CONFIRMACAO_ATIVA = antes; }
  return enviados;
}

test("PAGO + ativado + rastreio do Pixel capturado: um Purchase com event_id do pedido e total com taxa", async () => {
  const f = criarFake({ pedido: cakto() });
  const e = await confirmar(f);
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].pedidoId, e[0].valorTotalCentavos, e[0].fbp, e[0].userAgent], ["p", 2799, "fb.1.1700000000000.1234567890", "Mozilla/5.0 (Teste)"]);
  assert.ok(f.estado.pedido.metaPurchaseEnviadoEm);
  assert.equal((await confirmar(f)).length, 0); // repetição não reenvia
});

test("não envia sem rastreio capturado, fora do Cortes/Cakto, ou sem pagamento confirmado", async () => {
  assert.equal((await confirmar(criarFake({ pedido: cakto({ metaRastreioCapturadoEm: null }) }))).length, 0);
  assert.equal((await confirmar(criarFake({ pedido: cakto({ provedor: "blackcat" }) }))).length, 0);
  assert.equal((await confirmar(criarFake({ pedido: cakto({ plano: { cortesNivel: "nenhum", nome: "Plus" } }) }))).length, 0);
  for (const status of ["PENDING", "CANCELLED", "REFUNDED"]) assert.equal((await confirmar(criarFake({ pedido: cakto() }), { status })).length, 0, status);
  assert.equal((await confirmar(criarFake({ pedido: cakto({ metaPurchaseEnviadoEm: new Date() }) }))).length, 0);
});

test("falha ou exceção da Meta não desfaz o pagamento nem impede o e-mail", async () => {
  for (const meta of [async () => ({ ok: false as const, motivo: "sem_confirmacao" as const }), async () => ({ ok: false as const, motivo: "indisponivel" as const }), async () => { throw new Error("meta fora"); }]) {
    const avisos: any[] = [];
    const f = criarFake({ pedido: cakto() });
    await confirmar(f, { meta, avisar: async (c: any) => { avisos.push(c); } });
    assert.equal(f.estado.pedido.status, "PAGO");
    assert.equal(f.estado.pedido.assinatura.status, "ATIVA");
    assert.equal(f.estado.pedido.metaPurchaseEnviadoEm, null);
    assert.deepEqual(f.invalidacoes, ["u"]);
  }
});
