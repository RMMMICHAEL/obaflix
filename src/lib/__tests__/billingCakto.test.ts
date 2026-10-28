import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import {
  OFERTAS_CAKTO, assinaturaWebhookValida, confirmadorCakto, provedorCakto, reaisParaCentavos, telefoneE164, pilotoCaktoAutorizado,
} from "../billing/cakto";
import { criarPedidoPix, type NovoPedido, type PedidoParaProvedor, type PrecoDoBanco, type RepositorioDePedidos } from "../billing/pedidos";
import { confirmarPedidoPorId, decidirConfirmacao } from "../billing/confirmacao";
import { confirmadorDoPedido, provedorDeCobranca } from "../billing/simulado";
import { POST as webhookCakto } from "../../app/api/billing/webhook/cakto/route";

const CONFIG = { clientId: "cid", clientSecret: "csecret" };

test("Cakto: piloto Start falha fechado sem token e recusa Pro/AI", () => {
  const token = "t".repeat(40);
  assert.equal(pilotoCaktoAutorizado("cortes-start", token, {}), false);
  assert.equal(pilotoCaktoAutorizado("cortes-start", "errado", { CAKTO_PILOTO_TOKEN: token }), false);
  assert.equal(pilotoCaktoAutorizado("cortes-start", token, { CAKTO_PILOTO_TOKEN: token }), true);
  assert.equal(pilotoCaktoAutorizado("cortes-pro", token, { CAKTO_PILOTO_TOKEN: token }), false);
  assert.equal(pilotoCaktoAutorizado("cortes-ai", token, { CAKTO_PILOTO_TOKEN: token }), false);
});
const PAGADOR = { nome: "Comprador Teste", email: "c@teste.invalid", telefone: "11987654321", documento: { numero: "12345678909", tipo: "cpf" as const } };

/** fetch falso: token OAuth + respostas por rota, registrando cada chamada. */
function fetchFalso(rotas: Record<string, () => Response | Promise<Response>>) {
  const chamadas: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    chamadas.push({ url, init });
    if (url.endsWith("/token/")) return Response.json({ access_token: "tok", expires_in: 36000, token_type: "Bearer" });
    const rota = Object.keys(rotas).find((r) => url.includes(r));
    return rota ? rotas[rota]() : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { f, chamadas };
}
const pagamento = (extra: Record<string, unknown> = {}) => Response.json({
  id: "ord-uuid-1", status: "waiting_payment", amount: "27.00", externalId: "adq-externo",
  offer: { id: "5g29gxj" }, pix: { qrCode: "000201PIX", expirationDate: "2026-11-01 01:30:00+00:00" }, ...extra,
}, { status: 201 });
const pedidoStart = (ref = "ref-fixa-1"): PedidoParaProvedor => ({ refExterna: ref, planoId: "cortes-start", valorCentavos: 2700, moeda: "BRL", descricao: "Cortes Start", pagador: PAGADOR });

test("Cakto: criação usa oferta fixa, token Bearer, idempotência pela refExterna e guarda o id do pedido Cakto", async () => {
  const { f, chamadas } = fetchFalso({ "/payments/": () => pagamento() });
  const p = provedorCakto(CONFIG, f);
  const r = await p.criarVenda(pedidoStart());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.venda.transacaoId, "ord-uuid-1"); // não o externalId da adquirente
  assert.equal(r.venda.valorCentavos, 2700);
  const pay = chamadas.find((c) => c.url.endsWith("/payments/"))!;
  const h = pay.init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer tok");
  assert.equal(h["X-Idempotency-Key"], "ref-fixa-1");
  const corpo = JSON.parse(String(pay.init.body));
  assert.deepEqual(corpo.items, [{ offerId: "5g29gxj", quantity: 1 }]);
  assert.equal(corpo.paymentMethod, "pix");
  assert.deepEqual(corpo.metadata, { sck: "ref-fixa-1" });
  assert.equal(corpo.customer.phone, "5511987654321");
  assert.match(corpo.customer.fingerprint, /^[0-9a-f]{32}$/);
  assert.equal("amount" in corpo, false); // o valor é o da oferta, nunca enviado
  // Reenvio do mesmo pedido: mesma chave, e o token é reaproveitado.
  await p.criarVenda(pedidoStart());
  const pays = chamadas.filter((c) => c.url.endsWith("/payments/"));
  assert.equal((pays[1].init.headers as Record<string, string>)["X-Idempotency-Key"], "ref-fixa-1");
  assert.equal(chamadas.filter((c) => c.url.endsWith("/token/")).length, 1);
});

test("Cakto: Start aceita somente taxa adicional de R$ 0,99 com base correta", async () => {
  const ok = await provedorCakto(CONFIG, fetchFalso({
    "/payments/": () => pagamento({ amount: "27.99", baseAmount: "27.00" }),
  }).f).criarVenda(pedidoStart());
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.venda.valorCentavos, 2700);

  for (const extra of [
    { amount: "27.99", baseAmount: "28.00" },
    { amount: "28.99", baseAmount: "27.00" },
  ]) {
    const inesperado = await provedorCakto(CONFIG, fetchFalso({
      "/payments/": () => pagamento(extra),
    }).f).criarVenda(pedidoStart());
    assert.ok(inesperado.ok);
    if (inesperado.ok) assert.notEqual(inesperado.venda.valorCentavos, 2700);
  }
});

test("Cakto: conversões estritas de valor e telefone", () => {
  assert.equal(reaisParaCentavos("27.00"), 2700);
  assert.equal(reaisParaCentavos("197"), 19700);
  assert.equal(reaisParaCentavos("4.7"), 470);
  for (const ruim of ["", "1,00", "-1.00", "1.001", 27.001, null, "abc"]) assert.equal(reaisParaCentavos(ruim), null);
  assert.equal(telefoneE164("(11) 98765-4321"), "5511987654321");
  assert.equal(telefoneE164("5511987654321"), "5511987654321");
  assert.equal(telefoneE164("123"), null);
});

test("Cakto: resposta fora do pedido (oferta errada) vira revisão com transação; falha ambígua não inventa venda", async () => {
  const r1 = await provedorCakto(CONFIG, fetchFalso({ "/payments/": () => pagamento({ offer: { id: "outra" } }) }).f).criarVenda(pedidoStart());
  assert.deepEqual(r1.ok ? null : [r1.falha, r1.transacaoId], ["estado_externo_inesperado", "ord-uuid-1"]);
  const timeout = (async (url: string) => {
    if (url.endsWith("/token/")) return Response.json({ access_token: "tok", expires_in: 36000 });
    throw Object.assign(new Error("t"), { name: "TimeoutError" });
  }) as unknown as typeof fetch;
  const r2 = await provedorCakto(CONFIG, timeout).criarVenda(pedidoStart());
  assert.deepEqual(r2.ok ? null : [r2.falha, r2.transacaoId], ["timeout", undefined]);
  // Valor fora da oferta nem chega à Cakto.
  const { f, chamadas } = fetchFalso({});
  const r3 = await provedorCakto(CONFIG, f).criarVenda({ ...pedidoStart(), valorCentavos: 1000 });
  assert.equal(r3.ok ? null : r3.falha, "configuracao");
  assert.equal(chamadas.length, 0);
});

// ── criarPedidoPix com o provedor Cakto ──────────────────────────────────────
const PRECO_PRO: PrecoDoBanco = { id: "pp-pro", planoId: "cortes-pro", rotulo: "30 dias", precoCentavos: 4700, duracaoDias: 30, moeda: "BRL", ativo: true, plano: { id: "cortes-pro", nome: "Cortes Pro", ativo: true, ordem: 0, cortesNivel: "lote" } };
function repo(periodos: Awaited<ReturnType<RepositorioDePedidos["periodosEmAberto"]>> = []) {
  const log: string[] = []; const criados: NovoPedido[] = [];
  const r: RepositorioDePedidos = {
    async buscarPreco() { return PRECO_PRO; },
    async buscarAdicionais() { return { telaMensalCentavos: null, servidorVipMensalCentavos: null }; },
    async periodosEmAberto() { return periodos; },
    async revisaoPendente() { return log.includes("REVISAO_MANUAL"); },
    async criar(d) { log.push("criar"); criados.push(d); return { id: "ped-1" }; },
    async registrarVenda() { log.push("AGUARDANDO"); },
    async registrarFalha(_id, d) { log.push(d.status); },
  };
  return { r, log, criados };
}
const provedorPro = (resposta: () => Response) => {
  const { f, chamadas } = fetchFalso({ "/payments/": resposta });
  return { p: provedorCakto(CONFIG, f), chamadas };
};
const proOk = () => pagamento({ amount: "47.00", offer: { id: "zfuzuex" } });

test("Cakto no pedido: refExterna gravada antes da chamada e usada como chave; nada é PAGO", async () => {
  const { r, log, criados } = repo();
  const { p, chamadas } = provedorPro(proOk);
  const res = await criarPedidoPix({ userId: "u1", planoId: "cortes-pro", planoPrecoId: "pp-pro", pagador: PAGADOR }, { repo: r, provedor: p, nomeDoProvedor: "cakto", gerarRef: () => "ref-gravada" });
  assert.equal(res.situacao, "criado");
  assert.deepEqual(log, ["criar", "AGUARDANDO"]);
  assert.equal(criados[0].provedor, "cakto");
  assert.equal(criados[0].refExterna, "ref-gravada");
  assert.equal((chamadas.find((c) => c.url.endsWith("/payments/"))!.init.headers as Record<string, string>)["X-Idempotency-Key"], "ref-gravada");
});

test("Cakto no pedido: valor cobrado divergente vai para revisão manual", async () => {
  const { r, log } = repo();
  const { p } = provedorPro(() => pagamento({ amount: "40.00", offer: { id: "zfuzuex" } }));
  const res = await criarPedidoPix({ userId: "u1", planoId: "cortes-pro", planoPrecoId: "pp-pro", pagador: PAGADOR }, { repo: r, provedor: p, nomeDoProvedor: "cakto" });
  assert.deepEqual(res.situacao === "revisao_manual" && res.motivo, "valor_divergente");
  assert.deepEqual(log, ["criar", "REVISAO_MANUAL"]);
});

test("Cakto: timeout, 5xx e resposta ambígua preservam referência em revisão, sem nova cobrança", async () => {
  for (const modo of ["timeout", "5xx", "sem_id"] as const) {
    const { r, log, criados } = repo();
    const { p, chamadas } = provedorPro(() => {
      if (modo === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return modo === "5xx" ? new Response(null, { status: 503 }) : Response.json({ status: "waiting_payment" });
    });
    const entrada = { userId: "u1", planoId: "cortes-pro", planoPrecoId: "pp-pro", pagador: PAGADOR };
    const deps = { repo: r, provedor: p, nomeDoProvedor: "cakto" as const, gerarRef: () => "referencia-pendente" };
    assert.equal((await criarPedidoPix(entrada, deps)).situacao, "revisao_manual");
    assert.equal((await criarPedidoPix(entrada, deps)).situacao, "revisao_pendente");
    assert.deepEqual(log, ["criar", "REVISAO_MANUAL"]);
    assert.equal(criados.length, 1);
    assert.equal(criados[0].refExterna, "referencia-pendente");
    const pagamentos = chamadas.filter((c) => c.url.endsWith("/payments/"));
    assert.equal(pagamentos.length, 1);
    assert.equal(JSON.parse(String(pagamentos[0].init.body)).metadata.sck, criados[0].refExterna);
  }
});

test("Cakto no pedido: upgrade com crédito (valor dinâmico) é recusado sem pedido e sem cobrança", async () => {
  const agora = new Date();
  const start = { id: "a1", planoId: "cortes-start", ordemDoPlano: 1, cortes: true, iniciaEm: new Date(agora.getTime() - 10 * 864e5), terminaEm: new Date(agora.getTime() + 20 * 864e5), valorPagoCentavos: 2700 };
  const { r, log } = repo([start]);
  const { p, chamadas } = provedorPro(proOk);
  const res = await criarPedidoPix({ userId: "u1", planoId: "cortes-pro", planoPrecoId: "pp-pro", pagador: PAGADOR }, { repo: r, provedor: p, nomeDoProvedor: "cakto", agora: () => agora });
  assert.deepEqual(res, { situacao: "compra_recusada", codigo: "valor_fora_da_oferta" });
  assert.deepEqual(log, []);
  assert.equal(chamadas.length, 0);
});

// ── Confirmação autenticada ──────────────────────────────────────────────────
const pedidoDoBanco = { id: "ped-1", userId: "u1", planoId: "cortes-start", planoPrecoId: "pp", status: "AGUARDANDO", valorCentavos: 2700, moeda: "BRL", duracaoDias: 30, transacaoId: "ord-uuid-1", expiraEm: new Date(Date.now() + 864e5) };
const OFERTA_START = { product: { id: "produto-start" }, price: "27.00", currency: "BRL", type: "unique" };
const consultar = (corpo: Record<string, unknown>, oferta: Record<string, unknown> = OFERTA_START) => confirmadorCakto(CONFIG, fetchFalso({
  "/orders/ord-uuid-1/": () => Response.json({ id: "ord-uuid-1", paymentMethod: "pix", type: "unique", product: { id: "produto-start" }, ...corpo }),
  "/offers/5g29gxj/": () => Response.json(oferta),
}).f);

test("Cakto confirmação: taxa Start de R$ 0,99 concilia e valor inesperado fica em revisão", async () => {
  const valido = await consultar({ status: "paid", amount: "27.99", baseAmount: "27.00" })("ord-uuid-1", { planoId: "cortes-start" });
  assert.ok(valido.ok);
  if (valido.ok) assert.equal(decidirConfirmacao(pedidoDoBanco, valido.confirmacao, new Date()), "ATIVAR");

  for (const dados of [
    { status: "paid", amount: "27.99", baseAmount: "26.00" },
    { status: "paid", amount: "28.99", baseAmount: "27.00" },
  ]) {
    const invalido = await consultar(dados)("ord-uuid-1", { planoId: "cortes-start" });
    assert.ok(invalido.ok);
    if (invalido.ok) assert.equal(decidirConfirmacao(pedidoDoBanco, invalido.confirmacao, new Date()), "REVISAR");
  }
});

test("Cakto confirmação: paid com valor e moeda certos ativa; divergências vão para revisão", async () => {
  const pago = await consultar({ status: "paid", amount: "27.00", paidAt: new Date().toISOString() })("ord-uuid-1", { planoId: "cortes-start" });
  assert.ok(pago.ok);
  if (pago.ok) assert.equal(decidirConfirmacao(pedidoDoBanco, pago.confirmacao, new Date()), "ATIVAR");
  const opcionaisNulos = await consultar({ status: "paid", amount: "27.00", currency: null, offer: null, offerId: null })("ord-uuid-1", { planoId: "cortes-start" });
  assert.ok(opcionaisNulos.ok);
  if (opcionaisNulos.ok) assert.equal(decidirConfirmacao(pedidoDoBanco, opcionaisNulos.confirmacao, new Date()), "ATIVAR");
  assert.deepEqual(await consultar({ status: "paid", amount: null, baseAmount: "27.00" })("ord-uuid-1", { planoId: "cortes-start" }), { ok: false, falha: "resposta_invalida" });
  for (const divergente of [
    { status: "paid", amount: "20.00" },
    { status: "paid", amount: "27.00", product: { id: "produto-pro" } },
    { status: "paid", amount: "27.00", paymentMethod: "credit_card" },
    { status: "paid", amount: "27.00", type: "subscription" },
    { status: "paid", amount: "27.00", offer: { id: "zfuzuex" } },
  ]) {
    const r = await consultar(divergente)("ord-uuid-1", { planoId: "cortes-start" });
    assert.ok(r.ok);
    if (r.ok) assert.equal(decidirConfirmacao(pedidoDoBanco, r.confirmacao, new Date()), "REVISAR", JSON.stringify(divergente));
  }
  for (const oferta of [
    { ...OFERTA_START, currency: "USD" }, { ...OFERTA_START, currency: undefined },
    { ...OFERTA_START, price: "47.00" }, { ...OFERTA_START, type: "subscription" },
    { ...OFERTA_START, product: { id: "outro" } },
  ]) {
    const r = await consultar({ status: "paid", amount: "27.00" }, oferta)("ord-uuid-1", { planoId: "cortes-start" });
    assert.ok(r.ok);
    if (r.ok) assert.equal(decidirConfirmacao(pedidoDoBanco, r.confirmacao, new Date()), "REVISAR");
  }
  const pendente = await consultar({ status: "waiting_payment", amount: "27.00" })("ord-uuid-1");
  if (pendente.ok) assert.equal(decidirConfirmacao(pedidoDoBanco, pendente.confirmacao, new Date()), "MANTER");
});

test("Cakto confirmação: reembolso e chargeback estornam; status ambíguo não decide nada", async () => {
  for (const status of ["refunded", "chargedback"]) {
    const r = await consultar({ status, amount: "27.00" })("ord-uuid-1");
    assert.ok(r.ok);
    if (r.ok) assert.equal(decidirConfirmacao({ ...pedidoDoBanco, status: "PAGO" }, r.confirmacao, new Date()), "ESTORNAR");
  }
  for (const status of ["prechargeback", "refund_requested", "in_protest"]) {
    assert.deepEqual(await consultar({ status, amount: "27.00" })("ord-uuid-1"), { ok: false, falha: "resposta_invalida" });
  }
});

test("Cakto: consulta sem offer.id/currency usa a oferta oficial uma vez; erro de consulta não ativa", async () => {
  const { f, chamadas } = fetchFalso({
    "/orders/ord-uuid-1/": () => Response.json({ id: "ord-uuid-1", status: "paid", amount: "27.00", product: { id: "produto-start" }, paymentMethod: "pix", type: "unique" }),
    "/offers/5g29gxj/": () => Response.json({ ...OFERTA_START, product: "produto-start" }),
  });
  const r = await confirmadorCakto(CONFIG, f)("ord-uuid-1", { planoId: "cortes-start" });
  assert.ok(r.ok);
  if (r.ok) assert.equal(decidirConfirmacao(pedidoDoBanco, r.confirmacao, new Date()), "ATIVAR");
  assert.equal(chamadas.filter((c) => c.url.includes("/offers/")).length, 1);
  assert.equal(chamadas.filter((c) => c.url.includes("/token/")).length, 1);
  for (const c of chamadas.filter((c) => !c.url.includes("/token/"))) assert.equal((c.init.headers as Record<string, string>).Authorization, "Bearer tok");
  const falha = confirmadorCakto(CONFIG, fetchFalso({
    "/orders/ord-uuid-1/": () => Response.json({ id: "ord-uuid-1", status: "paid", amount: "27.00", product: { id: "produto-start" }, paymentMethod: "pix", type: "unique" }),
  }).f);
  assert.deepEqual(await falha("ord-uuid-1", { planoId: "cortes-start" }), { ok: false, falha: "indisponivel" });
  assert.deepEqual(await consultar({ id: "outra", status: "paid", amount: "27.00" })("ord-uuid-1", { planoId: "cortes-start" }), { ok: false, falha: "resposta_invalida" });
});

test("Confirmação roteia pelo provedor do pedido: Cakto não depende da chave da Blackcat", async () => {
  const antes = process.env.BLACKCAT_CONFIRMACAO_ATIVA;
  delete process.env.BLACKCAT_CONFIRMACAO_ATIVA;
  try {
    const consultas: unknown[][] = [];
    const prisma = (provedor: string) => ({ pedidoPagamento: { findUnique: async () => ({ ...pedidoDoBanco, provedor }) } }) as never;
    const consultarStatusBlackcat = async (...a: unknown[]) => { consultas.push(a); return { ok: false as const, falha: "indisponivel" as const }; };
    assert.deepEqual(await confirmarPedidoPorId("ped-1", { prisma: prisma("blackcat"), consultarStatusBlackcat }), { resultado: "desligada" });
    assert.deepEqual(await confirmarPedidoPorId("ped-1", { prisma: prisma("cakto"), consultarStatusBlackcat }), { resultado: "retry" });
    assert.deepEqual(consultas, [["ord-uuid-1", { planoId: "cortes-start" }]]);
  } finally { if (antes !== undefined) process.env.BLACKCAT_CONFIRMACAO_ATIVA = antes; }
});

// ── Webhook ──────────────────────────────────────────────────────────────────
const SEGREDO = "segredo-webhook-teste";
function requisicao(corpo: string, { ts = String(Math.floor(Date.now() / 1000)), assinar = SEGREDO } = {}) {
  const sig = "v1=" + crypto.createHmac("sha256", assinar).update(`${ts}.${corpo}`).digest("hex");
  return new NextRequest("https://obaflix.test/api/billing/webhook/cakto", { method: "POST", body: corpo, headers: { "x-cakto-timestamp": ts, "x-cakto-signature": sig, "content-type": "application/json" } });
}
function webhook(env: Record<string, string> = { CAKTO_WEBHOOK_SECRET: SEGREDO }) {
  const eventos: unknown[] = []; const confirmados: string[] = []; let duplicar = false;
  const prisma = {
    pedidoPagamento: { findFirst: async ({ where }: any) => (where.transacaoId === "ord-uuid-1" && where.provedor === "cakto" ? { id: "ped-1", userId: "u1" } : null) },
    eventoPagamento: { create: async ({ data }: any) => { if (duplicar) throw new Error("P2002"); eventos.push(data); } },
  };
  const handler = webhookCakto.createForTest({ prisma, env, confirmarPedidoPorId: async (id: string) => { confirmados.push(id); return { resultado: "ok" }; } });
  return { handler, eventos, confirmados, duplicado: () => { duplicar = true; } };
}
const APROVADO = JSON.stringify({ secret: "ignorado", event: "purchase_approved", data: { id: "ord-uuid-1", status: "paid" } });

test("Webhook Cakto: assinatura inválida, expirada ou sem segredo configurado é recusada sem efeito", async () => {
  const w = webhook();
  assert.equal((await w.handler(requisicao(APROVADO, { assinar: "outro" }))).status, 401);
  assert.equal((await w.handler(requisicao(APROVADO, { ts: String(Math.floor(Date.now() / 1000) - 301) }))).status, 401);
  assert.equal((await webhook({}).handler(requisicao(APROVADO))).status, 404);
  assert.deepEqual([w.eventos.length, w.confirmados.length], [0, 0]);
  // Corpo alterado depois de assinado.
  const req = requisicao(APROVADO);
  const adulterado = new NextRequest(req.url, { method: "POST", body: APROVADO.replace("paid", "PAID"), headers: req.headers });
  assert.equal((await w.handler(adulterado)).status, 401);
  assert.equal(assinaturaWebhookValida(SEGREDO, "1", "v1=zz", Buffer.from("")), false);
});

test("Webhook Cakto: purchase_approved registra e só pede a consulta autenticada; reenvio é deduplicado", async () => {
  const w = webhook();
  assert.equal((await w.handler(requisicao(APROVADO))).status, 200);
  assert.deepEqual(w.eventos, [{ provedor: "cakto", transacaoId: "ord-uuid-1", evento: "purchase_approved", statusInformado: "paid", pedidoId: "ped-1", resultado: "recebido" }]);
  assert.deepEqual(w.confirmados, ["ped-1"]);
  w.duplicado();
  assert.equal((await w.handler(requisicao(APROVADO))).status, 200);
  assert.deepEqual(w.confirmados, ["ped-1"]);
  // Evento que não muda direito é ignorado.
  const outro = webhook();
  await outro.handler(requisicao(JSON.stringify({ event: "pix_gerado", data: { id: "ord-uuid-1" } })));
  assert.deepEqual([outro.eventos.length, outro.confirmados.length], [0, 0]);
});

test("Webhook Cakto: sck autenticado vincula só revisão sem transação e não libera acesso", async () => {
  const sck = "a".repeat(32);
  const pendente = { ...pedidoDoBanco, status: "REVISAO_MANUAL", transacaoId: null as string | null };
  let vinculos = 0, consultas = 0;
  const eventos = new Set<string>();
  const prisma = {
    pedidoPagamento: {
      findFirst: async ({ where }: any) => pendente.transacaoId === where.transacaoId ? pendente : null,
      updateMany: async ({ where, data }: any) => {
        assert.deepEqual(where, { provedor: "cakto", refExterna: sck, transacaoId: null, status: "REVISAO_MANUAL" });
        if (pendente.transacaoId !== null) return { count: 0 };
        pendente.transacaoId = data.transacaoId; vinculos++; return { count: 1 };
      },
    },
    eventoPagamento: { create: async () => { if (eventos.has("aviso")) throw new Error("P2002"); eventos.add("aviso"); } },
  };
  const handler = webhookCakto.createForTest({ prisma, env: { CAKTO_WEBHOOK_SECRET: SEGREDO }, confirmarPedidoPorId: async () => {
    consultas++;
    const r = await consultar({ status: "paid", amount: "27.00" })("ord-uuid-1", { planoId: "cortes-start" });
    assert.ok(r.ok);
    if (r.ok) assert.equal(decidirConfirmacao(pendente, r.confirmacao, new Date()), "MANTER");
  } });
  const corpo = JSON.stringify({ event: "purchase_approved", data: { id: "ord-uuid-1", sck, status: "paid" } });
  assert.equal((await handler(requisicao(corpo, { assinar: "outro" }))).status, 401);
  assert.equal(vinculos, 0);
  await handler(requisicao(corpo));
  await handler(requisicao(corpo));
  assert.equal(vinculos, 1);
  assert.equal(consultas, 1);
  assert.equal(pendente.status, "REVISAO_MANUAL");
});

test("Cakto: confirmação autenticada ativa uma assinatura; webhook e confirmação repetidos não duplicam", async () => {
  const pedido = { ...pedidoDoBanco, provedor: "cakto", plano: { cortesNivel: "individual" } };
  const assinaturas: any[] = [];
  const eventos = new Set<string>();
  let emails = 0;
  const banco: any = {
    user: { findUnique: async () => ({ email: "comprador@example.test", senhaHash: "h" }) },
    pedidoPagamento: {
      findUnique: async () => ({ ...pedido, assinatura: assinaturas[0] ?? null }),
      findFirst: async () => pedido,
      update: async ({ data }: any) => Object.assign(pedido, data),
    },
    assinatura: { findMany: async () => [], create: async ({ data }: any) => { assinaturas.push(data); return data; } },
    eventoPagamento: { create: async () => { if (eventos.has("aviso")) throw new Error("P2002"); eventos.add("aviso"); } },
    $transaction: async (fn: any) => fn(banco),
  };
  const confirmar = () => confirmarPedidoPorId(pedido.id, { prisma: banco, consultarStatusBlackcat: consultar({ status: "paid", amount: "27.00" }), invalidarEntitlements: async () => {}, notificarPrimeiroAcesso: async () => { emails++; } });
  const handler = webhookCakto.createForTest({ prisma: banco, env: { CAKTO_WEBHOOK_SECRET: SEGREDO }, confirmarPedidoPorId: confirmar });
  await handler(requisicao(APROVADO));
  await handler(requisicao(APROVADO));
  await confirmar();
  assert.equal(pedido.status, "PAGO");
  assert.equal(assinaturas.length, 1);
  assert.equal(assinaturas[0].pedidoId, pedido.id);
  assert.equal(emails, 1);
});

// ── Regressão Blackcat ───────────────────────────────────────────────────────
test("Regressão Blackcat: sem CAKTO_PIX_ATIVO tudo segue na Blackcat; Cakto só para Cortes com oferta", () => {
  const base = { BLACKCAT_PIX_ATIVO: "true", BLACKCAT_API_KEY: "k".repeat(32) };
  assert.equal(provedorDeCobranca(base, "cortes-pro").nome, "blackcat");
  assert.equal(provedorDeCobranca({ ...base, CAKTO_PIX_ATIVO: "false", CAKTO_CLIENT_ID: "a", CAKTO_CLIENT_SECRET: "b" }, "cortes-pro").nome, "blackcat");
  const comCakto = { ...base, CAKTO_PIX_ATIVO: "true", CAKTO_CLIENT_ID: "a", CAKTO_CLIENT_SECRET: "b" };
  assert.equal(provedorDeCobranca(comCakto, "cortes-pro").nome, "cakto");
  assert.equal(provedorDeCobranca(comCakto, "plus").nome, "blackcat");
  // Só Cakto ligada: plano tradicional não tem provedor (503), nunca cai na Cakto.
  assert.equal(provedorDeCobranca({ CAKTO_PIX_ATIVO: "true", CAKTO_CLIENT_ID: "a", CAKTO_CLIENT_SECRET: "b" }, "plus").provedor, null);
  assert.equal(confirmadorDoPedido("cakto", base), null);
  assert.equal(typeof confirmadorDoPedido("blackcat", base), "function");
  assert.deepEqual(Object.keys(OFERTAS_CAKTO), ["cortes-start", "cortes-pro", "cortes-ai"]);
});
