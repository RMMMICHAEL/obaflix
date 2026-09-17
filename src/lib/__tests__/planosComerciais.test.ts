import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SERVIDOR_VIP_AVULSO_OFERTADO, SERVIDOR_VIP_NA_VITRINE, nomePublicoDoPlano, vitrineDoPlano } from "../billing/vitrine";
import { validarOpcoesComerciais } from "../billing/opcoes";
import {
  AJUSTES_DE_PLANO,
  PRECOS_DE_ADICIONAIS,
  PRECOS_DE_PLANO,
  bancoConfirmado,
  planejarCatalogo,
  podeAplicar,
  type EstadoDoCatalogo,
} from "../billing/catalogoComercial";
import { videoPermitidoPorVip, servidorVipDaConta } from "../servidorVip";
import { PLANO_BASIC, PLANO_GRATUITO, PLANO_PLUS, PLANO_PREMIUM } from "../planos";
import type { Entitlements } from "../entitlements";
import type { PlanoSemeado } from "../planos";

/**
 * A definição comercial final: vitrine, catálogo de preços, opções do pedido e
 * servidor VIP.
 */

const textos = (p: PlanoSemeado) => vitrineDoPlano(p).beneficios.map((b) => b.texto);
const incluido = (p: PlanoSemeado, texto: string) =>
  vitrineDoPlano(p).beneficios.find((b) => b.texto === texto)?.incluido;

describe("matriz final na vitrine", () => {
  test("nomes públicos: Básico, Plus, Premium — nunca Basic", () => {
    assert.equal(vitrineDoPlano(PLANO_BASIC).nome, "Básico");
    assert.equal(vitrineDoPlano(PLANO_PLUS).nome, "Plus");
    assert.equal(vitrineDoPlano(PLANO_PREMIUM).nome, "Premium");
    assert.equal(nomePublicoDoPlano("basic", "Basic"), "Básico");
    for (const p of [PLANO_GRATUITO, PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM]) {
      assert.equal(JSON.stringify(vitrineDoPlano(p)).includes("Basic"), false, p.id);
    }
  });

  test("gratuito: 1 tela, com anúncios, sem downloads, sem canais, SD", () => {
    assert.deepEqual(textos(PLANO_GRATUITO), [
      "1 tela", "Filmes e séries", "Qualidade SD", "Com anúncios na reprodução", "Sem downloads", "Sem canais de TV",
    ]);
  });

  test("Básico: 2 telas, HD, sem anúncios, sem downloads, sem canais", () => {
    assert.deepEqual(textos(PLANO_BASIC), [
      "2 telas simultâneas", "Filmes e séries", "Suporte a HD", "Sem anúncios", "Sem downloads", "Sem canais de TV", "Suporte padrão",
    ]);
    assert.equal(incluido(PLANO_BASIC, "Sem downloads"), false);
    assert.equal(textos(PLANO_BASIC).some((t) => /download/i.test(t) && /anúncio/i.test(t)), false);
  });

  test("Plus: Full HD, downloads sem anúncios, canais até o nível Plus", () => {
    assert.deepEqual(textos(PLANO_PLUS), [
      "2 telas simultâneas", "Filmes e séries", "Suporte a Full HD", "Sem anúncios",
      "Downloads sem anúncios", "Canais até o nível Plus", "Suporte",
    ]);
    assert.equal(textos(PLANO_PLUS).some((t) => /todos os canais/i.test(t)), false);
  });

  test("Premium: até 4K quando disponível, canais até o nível Premium, suporte prioritário", () => {
    assert.deepEqual(textos(PLANO_PREMIUM), [
      "2 telas simultâneas", "Filmes e séries", "Suporte a até 4K quando disponível", "Sem anúncios",
      "Downloads sem anúncios", "Canais até o nível Premium", "Suporte prioritário",
    ]);
  });

  test("com preço de tela ativo, a vitrine anuncia até 2 telas adicionais", () => {
    const v = vitrineDoPlano({ ...PLANO_PLUS, telasAdicionaisDisponiveis: true });
    assert.equal(v.beneficios[1].texto, "Até 2 telas adicionais");
    assert.equal(textos(PLANO_PLUS).includes("Até 2 telas adicionais"), false, "sem preço, sem anúncio");
  });

  test("qualidade é anunciada como suporte, nunca como limite aplicado", () => {
    for (const p of [PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM]) {
      assert.equal(textos(p).some((t) => /limit/i.test(t)), false, p.id);
    }
  });

  test("temas e selos", () => {
    assert.deepEqual(
      [PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM].map((p) => [vitrineDoPlano(p).tema, vitrineDoPlano(p).selo]),
      [["azul", null], ["roxo", "Mais escolhido"], ["ambar", "Experiência completa"]],
    );
  });

  test("servidor VIP fora da vitrine e do checkout, mesmo com o direito existindo", () => {
    assert.equal(SERVIDOR_VIP_NA_VITRINE, false);
    assert.equal(SERVIDOR_VIP_AVULSO_OFERTADO, false);
    for (const p of [PLANO_GRATUITO, PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM]) {
      assert.equal(textos(p).some((t) => /vip/i.test(t)), false, p.id);
    }
  });

  test("direitos: telas, canais, downloads e VIP incluso por plano", () => {
    const planos = [PLANO_GRATUITO, PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM];
    assert.deepEqual(planos.map((p) => p.telasMax), [1, 2, 2, 2]);
    assert.deepEqual(planos.map((p) => p.canaisNivel), ["nenhum", "nenhum", "plus", "premium"]);
    assert.deepEqual(planos.map((p) => p.downloads), [false, false, true, true]);
    assert.deepEqual(planos.map((p) => p.servidorVip), [false, false, true, true]);
  });
});

describe("catálogo de preços", () => {
  const brl = (planoId: string, meses: number | null, dias: number | null) =>
    PRECOS_DE_PLANO.find((p) =>
      p.planoId === planoId &&
      (meses !== null ? p.duracao.tipo === "meses" && p.duracao.meses === meses : p.duracao.tipo === "dias" && p.duracao.dias === dias),
    )?.precoCentavos;

  test("três durações por plano, total do período em centavos", () => {
    assert.deepEqual(
      ["basic", "plus", "premium"].map((id) => [brl(id, null, 30), brl(id, 5, null), brl(id, 12, null)]),
      [[1000, 4490, 9590], [1990, 8990, 18990], [2990, 13490, 28490]],
    );
    assert.equal(PRECOS_DE_PLANO.length, 9);
  });

  test("5 meses e 1 ano são meses de calendário, não dias", () => {
    for (const p of PRECOS_DE_PLANO.filter((x) => x.rotulo !== "30 dias")) {
      assert.equal(p.duracao.tipo, "meses", `${p.planoId} ${p.rotulo}`);
    }
  });

  test("adicionais: tela por mês (10,00 / 9,95 / 14,95); VIP avulso 5,90 inativo", () => {
    assert.deepEqual(
      PRECOS_DE_ADICIONAIS.map((a) => [a.planoId, a.tipo, a.precoMensalCentavos, a.ativo]),
      [["basic", "tela", 1000, true], ["plus", "tela", 995, true], ["premium", "tela", 1495, true], ["basic", "servidor_vip", 590, false]],
    );
  });

  const vazio: EstadoDoCatalogo = {
    planos: [
      { id: "basic", nome: "Basic", resolucaoMax: "hd", servidorVip: false },
      { id: "plus", nome: "Plus", resolucaoMax: "hd", servidorVip: false },
      { id: "premium", nome: "Premium", resolucaoMax: "4k", servidorVip: false },
    ],
    precos: [],
    adicionais: [],
  };

  test("banco sem preços: cria 9 preços, 4 adicionais e ajusta os planos", () => {
    const acoes = planejarCatalogo(vazio);
    assert.equal(acoes.filter((a) => a.tipo === "criar_preco").length, 9);
    assert.equal(acoes.filter((a) => a.tipo === "criar_adicional").length, 4);
    assert.deepEqual(
      acoes.filter((a) => a.tipo === "atualizar_plano").map((a) => a.tipo === "atualizar_plano" && [a.planoId, a.campo, a.para]),
      [["basic", "nome", "Básico"], ["plus", "resolucaoMax", "fhd"], ["plus", "servidorVip", true], ["premium", "servidorVip", true]],
    );
    const anual = acoes.find((a) => a.tipo === "criar_preco" && a.planoId === "premium" && a.rotulo === "1 ano");
    assert.deepEqual(anual && anual.tipo === "criar_preco" && [anual.duracaoDias, anual.duracaoMeses], [null, 12]);
    assert.equal(podeAplicar(acoes), true);
    assert.equal(AJUSTES_DE_PLANO.length, 4);
  });

  test("valor ativo diferente é conflito, nunca sobrescrita", () => {
    const acoes = planejarCatalogo({
      ...vazio,
      precos: [{ planoId: "plus", duracaoDias: null, duracaoMeses: 5, precoCentavos: 7000, moeda: "BRL", ativo: true }],
      adicionais: [{ planoId: "premium", tipo: "tela", precoMensalCentavos: 1000, moeda: "BRL", ativo: true }],
    });
    assert.ok(acoes.some((a) => a.tipo === "conflito_de_preco" && a.planoId === "plus" && a.rotulo === "5 meses"));
    assert.ok(acoes.some((a) => a.tipo === "conflito_de_adicional" && a.planoId === "premium"));
    assert.equal(podeAplicar(acoes), false);
  });

  test("preço de 30 dias não conta como 1 mês, nem o contrário", () => {
    const acoes = planejarCatalogo({
      ...vazio,
      precos: [{ planoId: "basic", duracaoDias: 30, duracaoMeses: null, precoCentavos: 1000, moeda: "BRL", ativo: true }],
    });
    assert.ok(acoes.some((a) => a.tipo === "preco_ja_correto" && a.planoId === "basic" && a.rotulo === "30 dias"));
    assert.ok(acoes.some((a) => a.tipo === "criar_preco" && a.planoId === "basic" && a.rotulo === "5 meses"));
  });

  test("apply exige o host exato do banco", () => {
    const url = "postgresql://u:p@db.exemplo.invalido:5432/postgres";
    assert.equal(bancoConfirmado(url, "db.exemplo.invalido"), true);
    assert.equal(bancoConfirmado(url, "outro.invalido"), false);
    assert.equal(bancoConfirmado(url, undefined), false);
    assert.equal(bancoConfirmado(undefined, "db.exemplo.invalido"), false);
  });
});

describe("opções do pedido", () => {
  test("sem opções: aceito com zero telas e sem VIP", () => {
    assert.deepEqual(validarOpcoesComerciais({}), { ok: true, telasAdicionais: 0, servidorVip: false });
    assert.deepEqual(validarOpcoesComerciais({ cupom: "", adicionais: [], telasAdicionais: 2, servidorVip: false }), {
      ok: true, telasAdicionais: 2, servidorVip: false,
    });
  });

  test("cupom informado é recusado — sem regra, sem desconto fictício", () => {
    for (const cupom of ["BEMVINDO", "  DESCONTO10 ", "0"]) {
      assert.deepEqual(validarOpcoesComerciais({ cupom }), { ok: false, codigo: "cupom_invalido" }, cupom);
    }
    assert.deepEqual(validarOpcoesComerciais({ cupom: 10 }), { ok: false, codigo: "parametros_invalidos" });
    assert.deepEqual(validarOpcoesComerciais({ cupom: "x".repeat(65) }), { ok: false, codigo: "parametros_invalidos" });
  });

  test("formato de telas, VIP e adicionais genéricos", () => {
    assert.deepEqual(validarOpcoesComerciais({ telasAdicionais: -1 }), { ok: false, codigo: "parametros_invalidos" });
    assert.deepEqual(validarOpcoesComerciais({ telasAdicionais: 1.5 }), { ok: false, codigo: "parametros_invalidos" });
    assert.deepEqual(validarOpcoesComerciais({ servidorVip: "sim" }), { ok: false, codigo: "parametros_invalidos" });
    assert.deepEqual(validarOpcoesComerciais({ adicionais: [{ tipo: "tela" }] }), { ok: false, codigo: "adicional_indisponivel" });
    assert.deepEqual(validarOpcoesComerciais({ adicionais: "tela" }), { ok: false, codigo: "parametros_invalidos" });
  });
});

describe("fiação no servidor", () => {
  const fonte = async (caminho: string) => (await import("node:fs")).readFileSync(caminho, "utf8");

  test("pedido: opções validadas antes de pagador, provedor e pedido", async () => {
    const rota = await fonte("src/app/api/billing/orders/route.ts");
    const validacao = rota.indexOf("validarOpcoesComerciais(corpo");
    assert.ok(validacao > 0);
    assert.ok(validacao > rota.indexOf("campoFinanceiroNoCorpo(corpo"), "depois da fronteira financeira");
    assert.ok(validacao < rota.indexOf("montarPagador(conta"), "antes do pagador");
    assert.ok(validacao < rota.indexOf("provedorDeCobranca()"), "antes do provedor");
    assert.ok(validacao < rota.indexOf("criarPedidoPix("), "antes de criar pedido");
  });

  test("pedido: assinatura vigente não é mais recusada por 409", async () => {
    const rota = await fonte("src/app/api/billing/orders/route.ts");
    assert.equal(rota.includes('"assinatura_ativa"'), false);
    assert.ok(rota.includes("periodosEmAberto"));
  });

  test("VIP: os dois caminhos que listam ou resolvem vídeo premium passam o direito", async () => {
    const extract = await fonte("src/app/api/player/extract/route.ts");
    const nativa = await fonte("src/app/api/player/fonte-nativa/route.ts");
    assert.ok(extract.includes("servidorVip: await servidorVipDaConta(userId)"));
    assert.ok(extract.includes("servidorVip: opcoes.servidorVip"));
    assert.ok(nativa.includes("servidorVip: await servidorVipDaConta(userId)"));
  });

  test("VIP: filtro antes de rotular e bloqueio do videoId direto; extrator sem banco", async () => {
    const cinevs = await fonte("src/lib/cinevs.ts");
    const filtro = cinevs.indexOf("const permitidos = videos.filter");
    assert.ok(filtro > 0 && filtro < cinevs.indexOf("rotularFontes(permitidos"));
    assert.ok(cinevs.includes("pedida && !videoPermitidoPorVip(Boolean(pedida.is_premium), q.servidorVip)"));
    assert.ok(cinevs.includes('from "./servidorVipRegra"'));
  });
});

describe("servidor VIP", () => {
  const ent = (servidorVip: boolean): Entitlements => ({
    assinatura: { ativa: true, planoId: "x", expiraEm: new Date("2030-01-01") },
    direitos: { ...PLANO_BASIC, servidorVip },
  });

  test("regra: sem direito, premium bloqueado; comum liberado; com direito, liberado", () => {
    assert.equal(videoPermitidoPorVip(true, false), false);
    assert.equal(videoPermitidoPorVip(false, false), true);
    assert.equal(videoPermitidoPorVip(true, true), true);
    assert.equal(videoPermitidoPorVip(true, undefined), true);
  });

  test("monetização desligada: sem filtro e sem consultar nada", async () => {
    let consultou = false;
    const r = await servidorVipDaConta("u", { ativa: false, resolver: async () => { consultou = true; return ent(true); } });
    assert.equal(r, undefined);
    assert.equal(consultou, false);
  });

  test("monetização ligada: o direito real decide, nunca o nome do plano", async () => {
    assert.equal(await servidorVipDaConta("u", { ativa: true, resolver: async () => ent(true) }), true);
    assert.equal(await servidorVipDaConta("u", { ativa: true, resolver: async () => ent(false) }), false);
  });

  test("falha ao resolver o direito não libera VIP", async () => {
    assert.equal(await servidorVipDaConta("u", { ativa: true, resolver: async () => { throw new Error("redis"); } }), false);
  });
});
