import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as webhookPost } from "../../app/api/billing/webhook/blackcat/[segredo]/route";
import { GET as pedidoGet } from "../../app/api/billing/orders/[id]/route";
import { GET as reconcileGet } from "../../app/api/cron/billing-reconcile/route";
const createWebhookBlackcatHandler = webhookPost.createForTest;
const createGetPedidoHandler = pedidoGet.createForTest;
const createBillingReconcileHandler = reconcileGet.createForTest;

const webhookRequest = (headers: Record<string, string> = {}) => new NextRequest("http://local", {
  method: "POST",
  headers: { "x-webhook-source": "blackcat-api", "x-webhook-event": "transaction.paid", ...headers },
});

test("webhook rejeita flag, segredo, origem, corpo e evento inválidos sem confirmar", async () => {
  for (const caso of [
    { env: { BLACKCAT_CONFIRMACAO_ATIVA: "false", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, params: "s" },
    { env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, params: "errado" },
    { env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, params: "s", headers: { "x-webhook-source": "forjado" } },
    { env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, params: "s", body: undefined },
    { env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, params: "s", body: { status: "PAID" } },
    { env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, params: "s", headers: { "x-webhook-event": "" } },
    { env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, params: "s", headers: { "x-webhook-event": "withdrawal.paid" } },
  ]) {
    let confirmou = 0;
    const handler = createWebhookBlackcatHandler({
      env: caso.env, clientIp: () => "ip", checkRateLimit: async () => ({ allowed: true }),
      readJsonBody: async () => (Object.hasOwn(caso, "body") ? caso.body : { transactionId: "tx", status: "PAID" }),
      prisma: { pedidoPagamento: { findUnique: async () => null }, eventoPagamento: { create: async () => undefined } },
      confirmarPedidoPorId: async () => { confirmou++; },
    });
    const response = await handler(webhookRequest(caso.headers as Record<string, string> | undefined), { params: { segredo: caso.params } });
    assert.ok([200, 404].includes(response.status));
    assert.equal(confirmou, 0);
  }
});

test("webhook desconhecido ou duplicado não cria direito e armazena apenas evento mínimo", async () => {
  const eventos: any[] = [];
  const desconhecido = createWebhookBlackcatHandler({
    env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, clientIp: () => "ip", checkRateLimit: async () => ({ allowed: true }),
    readJsonBody: async () => ({ transactionId: "tx-desconhecida", status: "PAID", amount: 999, customer: { email: "pii@example.com" } }),
    prisma: { pedidoPagamento: { findUnique: async () => null }, eventoPagamento: { create: async ({ data }: any) => { eventos.push(data); } } },
    confirmarPedidoPorId: async () => assert.fail("não deve confirmar transação desconhecida"),
  });
  await desconhecido(webhookRequest(), { params: { segredo: "s" } });
  assert.deepEqual(Object.keys(eventos[0]).sort(), ["evento", "pedidoId", "provedor", "resultado", "statusInformado", "transacaoId"].sort());
  assert.equal(JSON.stringify(eventos[0]).includes("pii@example.com"), false);

  const duplicado = createWebhookBlackcatHandler({
    env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, clientIp: () => "ip", checkRateLimit: async () => ({ allowed: true }),
    readJsonBody: async () => ({ transactionId: "tx", status: "PAID" }),
    prisma: { pedidoPagamento: { findUnique: async () => ({ id: "pedido", userId: "user" }) }, eventoPagamento: { create: async () => { throw new Error("unique"); } } },
    confirmarPedidoPorId: async () => assert.fail("duplicado não deve reconfirmar"),
  });
  assert.equal((await duplicado(webhookRequest(), { params: { segredo: "s" } })).status, 200);
});

test("webhook forjado só delega ao GET autoritativo e aguarda sua tentativa", async () => {
  for (const resultado of ["PENDING", "timeout", "network", "500"]) {
    let aguardado = false;
    // `const`: o contador nunca é reatribuído — é justamente o ponto do teste,
    // que nenhum destes quatro resultados cria assinatura.
    const assinaturas = 0;
    const handler = createWebhookBlackcatHandler({
      env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "s" }, clientIp: () => "ip", checkRateLimit: async () => ({ allowed: true }),
      readJsonBody: async () => ({ transactionId: "tx", status: "PAID", amount: 100 }),
      prisma: { pedidoPagamento: { findUnique: async () => ({ id: "pedido", userId: "user" }) }, eventoPagamento: { create: async () => undefined } },
      confirmarPedidoPorId: async () => {
        await Promise.resolve();
        aguardado = true;
        if (resultado === "PENDING") return { resultado: "pendente" };
        throw new Error(resultado);
      },
    });
    const response = await handler(webhookRequest(), { params: { segredo: "s" } });
    assert.equal(response.status, 200);
    assert.equal(aguardado, true);
    assert.equal(assinaturas, 0);
  }
});

test("polling protege sessão, propriedade, cache e campos expostos", async () => {
  const semSessao = createGetPedidoHandler({ getUserFromRequest: async () => null });
  assert.equal((await semSessao(new NextRequest("http://local"), { params: { id: "p" } })).status, 401);

  for (const pedido of [null, undefined]) {
    const handler = createGetPedidoHandler({ getUserFromRequest: async () => ({ userId: "dono" }), prisma: { pedidoPagamento: { findFirst: async () => pedido } } });
    assert.equal((await handler(new NextRequest("http://local"), { params: { id: "p" } })).status, 404);
  }

  let confirmou = 0;
  const handler = createGetPedidoHandler({
    getUserFromRequest: async () => ({ userId: "dono" }), confirmacaoAtiva: () => true, checkRateLimit: async () => ({ allowed: true }), confirmarPedidoPorId: async () => { confirmou++; },
    prisma: { pedidoPagamento: { findFirst: async () => ({ id: "p", status: "AGUARDANDO", valorCentavos: 100, moeda: "BRL", expiraEm: null, transacaoId: "tx" }), findUnique: async () => ({ id: "p", status: "AGUARDANDO", valorCentavos: 100, moeda: "BRL", expiraEm: null, transacaoId: "não-vazar" }) } },
  });
  const response = await handler(new NextRequest("http://local"), { params: { id: "p" } });
  assert.equal(confirmou, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(await response.json()).sort(), ["expiraEm", "id", "moeda", "status", "valorCentavos"].sort());
});

test("polling pendente, falho ou limitado não concede direito", async () => {
  for (const limite of [false, true]) {
    let confirmou = 0;
    const handler = createGetPedidoHandler({
      getUserFromRequest: async () => ({ userId: "u" }), confirmacaoAtiva: () => true, checkRateLimit: async () => ({ allowed: limite }),
      confirmarPedidoPorId: async () => { confirmou++; throw new Error("provider indisponível"); },
      prisma: { pedidoPagamento: { findFirst: async () => ({ id: "p", status: "AGUARDANDO", valorCentavos: 100, moeda: "BRL", expiraEm: null, transacaoId: "tx" }), findUnique: async () => ({ id: "p", status: "AGUARDANDO", valorCentavos: 100, moeda: "BRL", expiraEm: null }) } },
    });
    const resposta = await handler(new NextRequest("http://local"), { params: { id: "p" } });
    assert.equal((await resposta.json()).status, "AGUARDANDO");
    assert.equal(confirmou, limite ? 1 : 0);
  }
});

test("cron autentica, respeita flag, lote de 25 e isola erros", async () => {
  const naoAutorizado = createBillingReconcileHandler({ env: { CRON_SECRET: "s", BLACKCAT_CONFIRMACAO_ATIVA: "true" } });
  assert.equal((await naoAutorizado(new NextRequest("http://local"))).status, 401);
  const flagOff = createBillingReconcileHandler({ env: { CRON_SECRET: "s", BLACKCAT_CONFIRMACAO_ATIVA: "false" } });
  assert.deepEqual(await (await flagOff(new NextRequest("http://local", { headers: { authorization: "Bearer s" } }))).json(), { processados: 0 });

  const chamados: string[] = [];
  const cron = createBillingReconcileHandler({
    env: { CRON_SECRET: "s", BLACKCAT_CONFIRMACAO_ATIVA: "true" },
    prisma: { pedidoPagamento: { findMany: async (q: any) => { assert.equal(q.take, 25); assert.deepEqual(q.where, { status: "AGUARDANDO", transacaoId: { not: null } }); return [{ id: "webhook-perdido" }, { id: "falha" }, { id: "seguinte" }]; } } },
    confirmarPedidoPorId: async (id: string) => { chamados.push(id); if (id === "falha") throw new Error("transitório"); },
  });
  const resposta = await cron(new NextRequest("http://local", { headers: { authorization: "Bearer s" } }));
  assert.deepEqual(chamados, ["webhook-perdido", "falha", "seguinte"]);
  assert.deepEqual(await resposta.json(), { processados: 2 });
});
