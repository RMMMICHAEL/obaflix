import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as webhookPost } from "../../app/api/billing/webhook/blackcat/[segredo]/route";
import { GET as pedidoGet } from "../../app/api/billing/orders/[id]/route";
import { GET as reconcileGet } from "../../app/api/cron/billing-reconcile/route";
const createWebhookBlackcatHandler = webhookPost.createForTest;
const createGetPedidoHandler = pedidoGet.createForTest;
const createBillingReconcileHandler = reconcileGet.createForTest;

test("factory webhook executa inteiramente com fakes", async () => {
  let confirmou = "";
  const handler = createWebhookBlackcatHandler({
    env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: "segredo" },
    clientIp: () => "127.0.0.1",
    checkRateLimit: async () => ({ allowed: true }),
    readJsonBody: async () => ({ transactionId: "tx-1", status: "PAID", customer: { email: "nao-gravar@example.com" } }),
    prisma: {
      pedidoPagamento: { findUnique: async () => ({ id: "pedido-1", userId: "user-1" }) },
      eventoPagamento: {
        create: async ({ data }: any) => {
          assert.deepEqual(Object.keys(data).sort(), ["evento", "pedidoId", "provedor", "resultado", "statusInformado", "transacaoId"].sort());
          assert.equal(JSON.stringify(data).includes("nao-gravar@example.com"), false);
        },
      },
    },
    confirmarPedidoPorId: async (id: string) => { confirmou = id; },
  });
  const response = await handler(new NextRequest("http://local", { method: "POST", headers: { "x-webhook-source": "blackcat-api", "x-webhook-event": "transaction.paid" } }), { params: { segredo: "segredo" } });
  assert.equal(response.status, 200);
  assert.equal(confirmou, "pedido-1");
});

test("factory GET usa sessão, banco, limite e confirmação falsos", async () => {
  let confirmou = "";
  const pedido = { id: "pedido-1", status: "AGUARDANDO", valorCentavos: 100, moeda: "BRL", expiraEm: null, transacaoId: "tx-1" };
  const handler = createGetPedidoHandler({
    getUserFromRequest: async () => ({ userId: "user-1" }),
    checkRateLimit: async () => ({ allowed: true }),
    confirmarPedidoPorId: async (id: string) => { confirmou = id; },
    confirmacaoAtiva: () => true,
    prisma: { pedidoPagamento: { findFirst: async () => pedido, findUnique: async () => ({ id: "pedido-1", status: "PAGO", valorCentavos: 100, moeda: "BRL", expiraEm: null }) } },
  });
  const response = await handler(new NextRequest("http://local"), { params: { id: "pedido-1" } });
  assert.equal(confirmou, "pedido-1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(await response.json()).sort(), ["expiraEm", "id", "moeda", "status", "valorCentavos"].sort());
});

test("factory cron usa lote, ambiente e confirmação falsos", async () => {
  const chamados: string[] = [];
  const handler = createBillingReconcileHandler({
    env: { CRON_SECRET: "segredo", BLACKCAT_CONFIRMACAO_ATIVA: "true" },
    prisma: { pedidoPagamento: { findMany: async (query: any) => { assert.equal(query.take, 25); return [{ id: "a" }, { id: "b" }]; } } },
    confirmarPedidoPorId: async (id: string) => { chamados.push(id); },
  });
  const response = await handler(new NextRequest("http://local", { headers: { authorization: "Bearer segredo" } }));
  assert.deepEqual(chamados, ["a", "b"]);
  assert.deepEqual(await response.json(), { processados: 2 });
});

test("exports de produção instanciam as factories com defaults", async () => {
  for (const path of [
    "src/app/api/billing/webhook/blackcat/[segredo]/route.ts",
    "src/app/api/billing/orders/[id]/route.ts",
    "src/app/api/cron/billing-reconcile/route.ts",
  ]) {
    assert.match(await readFile(path, "utf8"), /export const (POST|GET)=Object\.assign\(create/);
  }
});
