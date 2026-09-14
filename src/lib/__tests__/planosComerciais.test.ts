import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SERVIDOR_VIP_NA_VITRINE, nomePublicoDoPlano, vitrineDoPlano } from "../billing/vitrine";
import { validarOpcoesComerciais } from "../billing/opcoes";
import {
  AJUSTES_DE_PLANO,
  PRECOS_DE_30_DIAS,
  PRECOS_PENDENTES_DE_SCHEMA,
  bancoConfirmado,
  planejarCatalogo,
  podeAplicar,
} from "../billing/catalogoComercial";
import { videoPermitidoPorVip, servidorVipDaConta } from "../servidorVip";
import { PLANO_BASIC, PLANO_GRATUITO, PLANO_PLUS, PLANO_PREMIUM } from "../planos";
import type { PlanoSemeado } from "../planos";

/**
 * A definição comercial final: vitrine, preços, opções do pedido e VIP.
 *
 * A vitrine é derivada dos direitos das constantes de bootstrap — as mesmas que
 * o seed grava —, então um direito divergente aparece aqui como texto errado.
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

  test("Básico: 2 telas, HD, sem anúncios, sem downloads nem promessa de downloads com anúncio, sem canais", () => {
    assert.deepEqual(textos(PLANO_BASIC), [
      "2 telas simultâneas", "Filmes e séries", "Suporte a HD", "Sem anúncios", "Sem downloads", "Sem canais de TV", "Suporte padrão",
    ]);
    assert.equal(incluido(PLANO_BASIC, "Sem downloads"), false);
    assert.equal(textos(PLANO_BASIC).some((t) => /download/i.test(t) && /anúncio/i.test(t)), false);
  });

  test("Plus: Full HD, downloads sem anúncios, canais até o nível Plus — nunca todos os canais", () => {
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

  test("qualidade é anunciada como suporte, nunca como limite aplicado", () => {
    for (const p of [PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM]) {
      assert.equal(textos(p).some((t) => /limit/i.test(t)), false, p.id);
    }
  });

  test("temas e selos; identificação não depende só da cor", () => {
    assert.deepEqual(
      [PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM].map((p) => [vitrineDoPlano(p).tema, vitrineDoPlano(p).selo]),
      [["azul", null], ["roxo", "Mais escolhido"], ["ambar", "Experiência completa"]],
    );
  });

  test("servidor VIP fora da vitrine enquanto não existir e não estiver protegido", () => {
    assert.equal(SERVIDOR_VIP_NA_VITRINE, false);
    for (const p of [PLANO_GRATUITO, PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM]) {
      assert.equal(textos(p).some((t) => /vip/i.test(t)), false, p.id);
    }
  });

  test("telas: 2 nos pagos; o gratuito preserva a regra atual", () => {
    assert.deepEqual([PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM].map((p) => p.telasMax), [2, 2, 2]);
    assert.equal(PLANO_GRATUITO.telasMax, 1);
  });

  test("canais por nível: gratuito e Básico nenhum, Plus plus, Premium premium", () => {
    assert.deepEqual(
      [PLANO_GRATUITO, PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM].map((p) => p.canaisNivel),
      ["nenhum", "nenhum", "plus", "premium"],
    );
  });

  test("Básico não concede downloads; Plus e Premium concedem", () => {
    assert.deepEqual(
      [PLANO_GRATUITO, PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM].map((p) => p.downloads),
      [false, false, true, true],
    );
  });
});

describe("preços", () => {
  test("30 dias: R$ 10,00, R$ 19,90, R$ 29,90 em centavos inteiros", () => {
    assert.deepEqual(PRECOS_DE_30_DIAS, [
      { planoId: "basic", precoCentavos: 1000 },
      { planoId: "plus", precoCentavos: 1990 },
      { planoId: "premium", precoCentavos: 2990 },
    ]);
  });

  test("5 meses e 1 ano: aprovados, registrados e não criáveis sem duração em meses", () => {
    assert.deepEqual(
      PRECOS_PENDENTES_DE_SCHEMA.map((p) => [p.planoId, p.meses, p.precoCentavos]),
      [["basic", 5, 4490], ["basic", 12, 9590], ["plus", 5, 8990], ["plus", 12, 18990], ["premium", 5, 13490], ["premium", 12, 28490]],
    );
    const estado = {
      planos: ["basic", "plus", "premium"].map((id) => ({ id, nome: id, resolucaoMax: "hd" })),
      precos: [],
    };
    const criadas = planejarCatalogo(estado).filter((a) => a.tipo === "criar_preco");
    assert.ok(criadas.every((a) => a.tipo === "criar_preco" && a.duracaoDias === 30));
  });

  test("banco sem preços: cria os três e ajusta nome e qualidade", () => {
    const acoes = planejarCatalogo({
      planos: [
        { id: "basic", nome: "Basic", resolucaoMax: "hd" },
        { id: "plus", nome: "Plus", resolucaoMax: "hd" },
        { id: "premium", nome: "Premium", resolucaoMax: "4k" },
      ],
      precos: [],
    });
    assert.equal(acoes.filter((a) => a.tipo === "criar_preco").length, 3);
    assert.deepEqual(
      acoes.filter((a) => a.tipo === "atualizar_plano"),
      [
        { tipo: "atualizar_plano", planoId: "basic", campo: "nome", de: "Basic", para: "Básico" },
        { tipo: "atualizar_plano", planoId: "plus", campo: "resolucaoMax", de: "hd", para: "fhd" },
      ],
    );
    assert.equal(podeAplicar(acoes), true);
    assert.equal(AJUSTES_DE_PLANO.length, 2);
  });

  test("preço ativo diferente é conflito, nunca sobrescrita", () => {
    const acoes = planejarCatalogo({
      planos: [{ id: "basic", nome: "Básico", resolucaoMax: "hd" }, { id: "plus", nome: "Plus", resolucaoMax: "fhd" }, { id: "premium", nome: "Premium", resolucaoMax: "4k" }],
      precos: [{ planoId: "plus", duracaoDias: 30, precoCentavos: 1500, moeda: "BRL", ativo: true }],
    });
    assert.ok(acoes.some((a) => a.tipo === "conflito_de_preco" && a.planoId === "plus"));
    assert.equal(podeAplicar(acoes), false);
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
  test("sem opções: aceito", () => {
    assert.deepEqual(validarOpcoesComerciais({}), { ok: true });
    assert.deepEqual(validarOpcoesComerciais({ cupom: "", adicionais: [], telasAdicionais: 0, servidorVip: false }), { ok: true });
  });

  test("cupom informado é recusado — não existe catálogo de cupons", () => {
    for (const cupom of ["BEMVINDO", "  DESCONTO10 ", "0"]) {
      assert.deepEqual(validarOpcoesComerciais({ cupom }), { ok: false, codigo: "cupom_invalido" }, cupom);
    }
    assert.deepEqual(validarOpcoesComerciais({ cupom: 10 }), { ok: false, codigo: "parametros_invalidos" });
    assert.deepEqual(validarOpcoesComerciais({ cupom: "x".repeat(65) }), { ok: false, codigo: "parametros_invalidos" });
  });

  test("telas adicionais e VIP avulso indisponíveis", () => {
    assert.deepEqual(validarOpcoesComerciais({ telasAdicionais: 1 }), { ok: false, codigo: "adicional_indisponivel" });
    assert.deepEqual(validarOpcoesComerciais({ servidorVip: true }), { ok: false, codigo: "adicional_indisponivel" });
    assert.deepEqual(validarOpcoesComerciais({ adicionais: [{ tipo: "tela" }] }), { ok: false, codigo: "adicional_indisponivel" });
    assert.deepEqual(validarOpcoesComerciais({ telasAdicionais: -1 }), { ok: false, codigo: "parametros_invalidos" });
    assert.deepEqual(validarOpcoesComerciais({ servidorVip: "sim" }), { ok: false, codigo: "parametros_invalidos" });
    assert.deepEqual(validarOpcoesComerciais({ adicionais: "tela" }), { ok: false, codigo: "parametros_invalidos" });
  });
});

describe("fiação no servidor", () => {
  const fonte = async (caminho: string) => (await import("node:fs")).readFileSync(caminho, "utf8");

  test("pedido: cupom e adicionais validados antes de pagador, pedido e provedor", async () => {
    const rota = await fonte("src/app/api/billing/orders/route.ts");
    const validacao = rota.indexOf("validarOpcoesComerciais(corpo");
    assert.ok(validacao > 0);
    assert.ok(validacao > rota.indexOf("campoFinanceiroNoCorpo(corpo"), "depois da fronteira financeira");
    assert.ok(validacao < rota.indexOf("montarPagador(conta"), "antes do pagador");
    assert.ok(validacao < rota.indexOf("criarProvedorBlackcat()"), "antes do provedor");
    assert.ok(validacao < rota.indexOf("criarPedidoPix("), "antes de criar pedido");
    assert.equal(/detail:[^\n]*cupom\b[^:]/.test(rota.replace("opcoes: ${opcoes.codigo}", "")), false, "valor do cupom fora do log");
  });

  test("VIP: os dois caminhos que listam ou resolvem vídeo premium passam o direito", async () => {
    const extract = await fonte("src/app/api/player/extract/route.ts");
    const nativa = await fonte("src/app/api/player/fonte-nativa/route.ts");
    assert.ok(extract.includes("servidorVip: await servidorVipDaConta(userId)"));
    assert.ok(extract.includes("servidorVip: opcoes.servidorVip"));
    assert.ok(nativa.includes("servidorVip: await servidorVipDaConta(userId)"));
  });

  test("VIP: filtro antes de rotular e bloqueio do videoId direto", async () => {
    const cinevs = await fonte("src/lib/cinevs.ts");
    const filtro = cinevs.indexOf("const permitidos = videos.filter");
    assert.ok(filtro > 0 && filtro < cinevs.indexOf("rotularFontes(permitidos"));
    assert.ok(cinevs.includes("pedida && !videoPermitidoPorVip(Boolean(pedida.is_premium), q.servidorVip)"));
  });
});

describe("servidor VIP", () => {
  test("sem direito: vídeo premium bloqueado; comum liberado", () => {
    assert.equal(videoPermitidoPorVip(true, false), false);
    assert.equal(videoPermitidoPorVip(false, false), true);
  });

  test("com direito: premium liberado", () => {
    assert.equal(videoPermitidoPorVip(true, true), true);
  });

  test("direito não modelado: nenhum filtro, comportamento anterior", async () => {
    assert.equal(await servidorVipDaConta("qualquer"), undefined);
    assert.equal(videoPermitidoPorVip(true, undefined), true);
  });
});
