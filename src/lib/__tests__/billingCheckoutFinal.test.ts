import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as plansGet } from "../../app/api/billing/plans/route";
import { GET as meGet } from "../../app/api/billing/me/route";
import { GET as pendingGet } from "../../app/api/billing/orders/pending/route";
import { acaoComercialDoPlano, corpoCriarPedido, deveFazerPolling, mensagemErroCheckout } from "../billing/checkout";

const req = new NextRequest("http://local");
const createPlansHandler = plansGet.createForTest;
const createBillingMeHandler = meGet.createForTest;
const createPendingOrderHandler = pendingGet.createForTest;
const plano = { id: "basic", nome: "Basic", descricao: "d", ehPadrao: false, filmes: true, series: true, downloads: true, telasMax: 1, anunciosObrigatorios: false };

test("catálogo comercial só expõe planos ativos, preços ativos e nenhum canal ou gateway", async () => {
  let consulta: any;
  const handler = createPlansHandler({ prisma: { plano: { findMany: async (q: any) => {
    consulta = q;
    return [{ ...plano, precos: [{ id: "preco", rotulo: "Mensal", duracaoDias: 30, precoCentavos: 1000, moeda: "BRL" }] }, { ...plano, id: "sem-preco", precos: [] }];
  } } } });
  const body = await (await handler()).json();
  assert.deepEqual(consulta.where, { ativo: true });
  assert.equal(body.planos[0].compravel, true); assert.equal(body.planos[1].compravel, false);
  assert.equal(JSON.stringify(body).match(/blackcat|transaction|secret|api.?key/i), null);
  // Nenhum catálogo de canais: a vitrine descreve o nível em texto, nunca lista canal.
  assert.equal(JSON.stringify(body).match(/"canais"\s*:|nivelMinimo|logoUrl/i), null);
  assert.equal(body.planos[0].nome, "Básico");
  assert.ok(Array.isArray(body.planos[0].vitrine.beneficios));
});

test("estado comercial exige sessão e devolve nome comercial sem campos administrativos", async () => {
  const semSessao = createBillingMeHandler({ getUserFromRequest: async () => null });
  assert.equal((await semSessao(req)).status, 401);
  const handler = createBillingMeHandler({ getUserFromRequest: async () => ({ userId: "u" }), entitlementsDoUsuario: async () => ({ assinatura: { ativa: true, planoId: "basic" } }), agora: () => new Date("2026-01-01"), prisma: { assinatura: { findFirst: async () => ({ terminaEm: new Date("2026-02-01") }) }, plano: { findUnique: async () => ({ id: "basic", nome: "Basic" }) } } });
  const body = await (await handler(req)).json();
  assert.deepEqual(body.plano, { id: "basic", nome: "Básico" }); assert.equal(body.assinatura.status, "ATIVA");
  assert.equal(JSON.stringify(body).match(/transaction|pedidoId|planoPreco|origem/i), null);
});

test("estado comercial gratuito, cancelado e vencido nunca se apresenta como assinatura ativa", async () => {
  for (const ativa of [false, false, false]) {
    const h = createBillingMeHandler({ getUserFromRequest: async () => ({ userId: "u" }), entitlementsDoUsuario: async () => ({ assinatura: { ativa, planoId: "gratuito" } }), prisma: { assinatura: { findFirst: async () => assert.fail("não consulta assinatura inativa") }, plano: { findUnique: async () => ({ id: "gratuito", nome: "Gratuito" }) } } });
    assert.equal((await (await h(req)).json()).assinatura, null);
  }
});

test("recuperação de pendente é autenticada, do dono, vigente e sem transactionId ou PIX", async () => {
  const semSessao = createPendingOrderHandler({ getUserFromRequest: async () => null });
  assert.equal((await semSessao(req)).status, 401);
  let where: any;
  const h = createPendingOrderHandler({ agora: () => new Date("2026-01-01"), getUserFromRequest: async () => ({ userId: "A" }), prisma: { revisaoPagamento: { findFirst: async () => null }, pedidoPagamento: { findFirst: async (q: any) => { where = q.where; return { id: "p", status: "AGUARDANDO", valorCentavos: 1000, moeda: "BRL", expiraEm: new Date("2026-01-02"), transacaoId: "nunca" }; } } } });
  const body = await (await h(req)).json();
  assert.equal(where.userId, "A"); assert.equal(body.pedido.pedidoId, "p");
  assert.equal(JSON.stringify(body).match(/transaction|pix/i), null);
});

test("checkout envia somente seleção e pagador, e encerra polling em todo estado terminal", () => {
  const corpo = corpoCriarPedido("p", "pp", { nome: "N", telefone: "1", documento: "2" });
  assert.deepEqual(Object.keys(corpo).sort(), ["documento", "nome", "planoId", "planoPrecoId", "telefone"]);
  for (const status of ["PAGO", "EXPIRADO", "CANCELADO", "ESTORNADO", "REVISAO_MANUAL"]) assert.equal(deveFazerPolling(status), false);
  assert.equal(deveFazerPolling("AGUARDANDO"), true);
  assert.match(mensagemErroCheckout("assinatura_ativa"), /assinatura ativa/);
  assert.match(mensagemErroCheckout("plano_indisponivel"), /indisponível/);
});

test("vitrine comercial permite renovar e mudar plano com assinatura ativa", () => {
  assert.deepEqual(acaoComercialDoPlano({ compravel: true, planoAtual: true, assinaturaAtiva: true }), { disponivel: true, rotulo: "Renovar" });
  assert.deepEqual(acaoComercialDoPlano({ compravel: true, planoAtual: false, assinaturaAtiva: true }), { disponivel: true, rotulo: "Alterar plano" });
  assert.deepEqual(acaoComercialDoPlano({ compravel: true, planoAtual: false, assinaturaAtiva: false }), { disponivel: true, rotulo: "Assinar" });
  assert.deepEqual(acaoComercialDoPlano({ compravel: false, planoAtual: false, assinaturaAtiva: true }), { disponivel: false, rotulo: "Indisponível" });
});
