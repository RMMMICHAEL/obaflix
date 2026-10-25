import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as plansGet } from "../../app/api/billing/plans/route";
import { GET as meGet } from "../../app/api/billing/me/route";
import { PLANOS_FORA_DA_VITRINE, PLANO_SEJA_PREMIUM_ID, nomePublicoDoPlano } from "../billing/vitrine";
import { PRECO_SEJA_PREMIUM, dadosDoPlanoSejaPremium, planejarSejaPremium, podeAplicarSejaPremium } from "../billing/sejaPremium";

const gratuito = {
  id: "gratuito", nome: "Gratuito", descricao: "d", ordem: 0, ativo: true, ehPadrao: true,
  anunciosObrigatorios: true, episodiosPorAnuncio: 3, janelaAnuncioHoras: 24,
  filmes: true, series: true, downloads: false, telasMax: 1, canaisNivel: "nenhum", resolucaoMax: "sd",
  tvNivel: "limitado", perfisMax: 1, servidorVip: false,
};
const linha = (id: string, extra: any = {}) => ({
  id, nome: id, descricao: "d", ehPadrao: false, filmes: true, series: true, downloads: false, telasMax: 1,
  anunciosObrigatorios: id === "gratuito" || id === PLANO_SEJA_PREMIUM_ID ? id === "gratuito" : false,
  canaisNivel: "nenhum", resolucaoMax: "sd",
  precos: [{ id: `preco-${id}`, rotulo: "30 dias", duracaoDias: 30, precoCentavos: 1000, moeda: "BRL" }],
  adicionais: [], ...extra,
});

test("o plano SEJA PREMIUM herda os direitos do Gratuito e só remove os anúncios", () => {
  const dados = dadosDoPlanoSejaPremium(gratuito) as any;
  for (const campo of ["filmes", "series", "downloads", "telasMax", "canaisNivel", "resolucaoMax", "tvNivel", "perfisMax", "servidorVip", "janelaAnuncioHoras"]) {
    assert.deepEqual(dados[campo], (gratuito as any)[campo], campo);
  }
  assert.equal(dados.anunciosObrigatorios, false);
  assert.equal(dados.ehPadrao, false);
  assert.equal(dados.id, PLANO_SEJA_PREMIUM_ID);
  assert.ok(dados.ordem < 1, "abaixo do Básico: comprar o Básico depois é upgrade");
  assert.equal(PRECO_SEJA_PREMIUM.precoCentavos, 1000);
  assert.equal(PRECO_SEJA_PREMIUM.duracaoDias, 30);
});

test("o cadastro é idempotente e recusa conflito, plano divergente ou Gratuito ausente", () => {
  const novo = planejarSejaPremium({ gratuito, plano: null, preco: null });
  assert.deepEqual(novo.map((a) => a.tipo), ["criar_plano", "criar_preco"]);
  assert.equal(podeAplicarSejaPremium(novo), true);

  const existente = planejarSejaPremium({
    gratuito, plano: dadosDoPlanoSejaPremium(gratuito), preco: { precoCentavos: 1000, duracaoDias: 30, moeda: "BRL" },
  });
  assert.deepEqual(existente.map((a) => a.tipo), ["plano_ja_existe", "preco_ja_correto"]);
  assert.equal(podeAplicarSejaPremium(existente), true);

  assert.equal(podeAplicarSejaPremium(planejarSejaPremium({ gratuito, plano: null, preco: { precoCentavos: 2000, duracaoDias: 30, moeda: "BRL" } })), false);
  assert.equal(podeAplicarSejaPremium(planejarSejaPremium({ gratuito, plano: { ...dadosDoPlanoSejaPremium(gratuito), telasMax: 5 }, preco: null })), false);
  assert.equal(podeAplicarSejaPremium(planejarSejaPremium({ gratuito: null, plano: null, preco: null })), false);
});

test("a vitrine pública não lista o SEJA PREMIUM; só ?oferta=seja-premium o devolve", async () => {
  const planos = [linha("gratuito"), linha("basic"), linha(PLANO_SEJA_PREMIUM_ID)];
  const handler = plansGet.createForTest({ prisma: { plano: { findMany: async (q: any) => { assert.deepEqual(q.where, { ativo: true }); return planos; } } } });
  const publica = await (await handler()).json();
  assert.deepEqual(publica.planos.map((p: any) => p.id), ["gratuito", "basic"]);
  assert.ok(PLANOS_FORA_DA_VITRINE.has(PLANO_SEJA_PREMIUM_ID));

  const oferta = await (await handler(new NextRequest(`http://local/api/billing/plans?oferta=${PLANO_SEJA_PREMIUM_ID}`))).json();
  assert.deepEqual(oferta.planos.map((p: any) => p.id), [PLANO_SEJA_PREMIUM_ID]);
  assert.equal(oferta.planos[0].precos[0].precoCentavos, 1000);

  // um valor desconhecido (ou um plano público) nunca abre outra porta: cai na lista pública
  const outro = await (await handler(new NextRequest("http://local/api/billing/plans?oferta=basic"))).json();
  assert.deepEqual(outro.planos.map((p: any) => p.id), ["gratuito", "basic"]);
});

test("o nome público do plano é SEJA PREMIUM e o tema fica vazio (fora do carrossel do site)", () => {
  assert.equal(nomePublicoDoPlano(PLANO_SEJA_PREMIUM_ID, "x"), "SEJA PREMIUM");
});

test("/api/billing/me informa anunciosObrigatorios pelos direitos efetivos, sem quebrar o contrato antigo", async () => {
  const req = new NextRequest("http://local");
  const montar = (direitos: any) => meGet.createForTest({
    getUserFromRequest: async () => ({ userId: "u" }),
    entitlementsDoUsuario: async () => ({ assinatura: { ativa: false, planoId: "gratuito", expiraEm: null }, direitos }),
    prisma: { assinatura: { findFirst: async () => null }, plano: { findUnique: async () => ({ id: "gratuito", nome: "Gratuito" }) } },
  });
  const comAnuncio = await (await montar({ anunciosObrigatorios: true })(req)).json();
  assert.equal(comAnuncio.anunciosObrigatorios, true);
  assert.deepEqual(comAnuncio.plano, { id: "gratuito", nome: "Gratuito" }); // campos antigos intactos
  assert.equal("assinatura" in comAnuncio, true);

  const semAnuncio = await (await montar({ anunciosObrigatorios: false })(req)).json();
  assert.equal(semAnuncio.anunciosObrigatorios, false);

  // direito ausente: falha para o lado seguro (pede anúncio), como no schema
  const ausente = await (await montar(undefined)(req)).json();
  assert.equal(ausente.anunciosObrigatorios, true);
});
