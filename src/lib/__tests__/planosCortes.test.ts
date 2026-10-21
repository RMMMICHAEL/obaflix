import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PLANOS_CORTES, PLANOS_COMERCIAIS, PLANO_GRATUITO, PLANO_BASIC,
  semearPlanosComerciais, type RepositorioDePlanos,
} from "../planos";
import { resolverEntitlements, EntitlementsIndefinidos, type AssinaturaCandidata } from "../entitlements";
import { autorizarCatalogo, downloadPermitido } from "../playbackAuthorization";
import { criarPedidoPix, type PrecoDoBanco, type RepositorioDePedidos } from "../billing/pedidos";
import { planejarAtivacao } from "../billing/confirmacao";
import { PRECOS_DE_PLANO, PRECOS_DE_ADICIONAIS, AJUSTES_DE_PLANO } from "../billing/catalogoComercial";

const agora = new Date("2026-10-19T12:00:00Z");
const assinatura = (plano: typeof PLANO_BASIC): AssinaturaCandidata => ({
  id: "unica", status: "ATIVA", iniciaEm: new Date("2026-10-01T12:00:00Z"),
  terminaEm: new Date("2026-11-01T12:00:00Z"), plano,
});

test("Cortes: catálogo próprio, inativo, sem preço, sem alterar planos tradicionais", () => {
  assert.deepEqual(PLANOS_CORTES.map(p => [p.id, p.nome, p.cortesNivel]), [
    ["cortes-start", "Obaflix Cortes Start", "individual"],
    ["cortes-pro", "Obaflix Cortes Pro", "lote"],
    ["cortes-ai", "Obaflix Cortes AI", "ia"],
  ]);
  assert.deepEqual(PLANOS_COMERCIAIS.map(p => p.id), ["basic", "plus", "premium"]);
  for (const p of PLANOS_CORTES) {
    assert.equal(p.ativo, false);
    assert.equal(p.ehPadrao, false);
    assert.equal(p.downloads, false);
    assert.equal(p.filmes && p.series, true);
    assert.deepEqual(Object.keys(p).sort(), Object.keys(PLANO_GRATUITO).sort());
    for (const linhas of [PRECOS_DE_PLANO, PRECOS_DE_ADICIONAIS, AJUSTES_DE_PLANO]) {
      assert.equal(linhas.some(l => l.planoId === p.id), false);
    }
    const { id, nome, descricao, ativo, cortesNivel, ...resto } = p;
    const { id: _id, nome: _nome, descricao: _descricao, ativo: _ativo, cortesNivel: _nivel, ...base } = PLANO_BASIC;
    assert.deepEqual(resto, base, "demais direitos reutilizam o Básico");
  }
});

test("seed combinado cria só o que falta, é idempotente e preserva ajustes existentes", async () => {
  const legado = { ...PLANO_BASIC, nome: "Ajustado no banco", telasMax: 1 };
  const linhas = new Map<string, Record<string, unknown>>([[legado.id, legado]]);
  let escritas = 0;
  const repo: RepositorioDePlanos = {
    buscar: async id => linhas.get(id) ?? null,
    criar: async plano => { assert.equal(linhas.has(plano.id), false); escritas++; linhas.set(plano.id, { ...plano }); },
  };
  const comerciais = [...PLANOS_COMERCIAIS, ...PLANOS_CORTES];
  await semearPlanosComerciais(repo, comerciais);
  assert.equal(escritas, 5);
  assert.deepEqual(linhas.get(legado.id), legado);
  const alterado = { ...PLANOS_CORTES[0], cortesNivel: "nenhum", ativo: true };
  linhas.set(alterado.id, alterado);
  const segunda = await semearPlanosComerciais(repo, comerciais);
  assert.equal(escritas, 5);
  assert.ok(segunda.every(r => r.resultado.acao === "mantido"));
  assert.deepEqual(linhas.get(alterado.id), alterado);
  const script = readFileSync("scripts/seed-planos.ts", "utf8");
  assert.ok(script.includes("[...PLANOS_COMERCIAIS, ...PLANOS_CORTES]"));
  assert.ok(script.includes("semearPlanosComerciais(repositorio, comerciaisDoSeed)"));
  assert.equal(script.includes("planoPreco.create"), false);
  assert.equal(script.includes("assinatura.create"), false);
});

test("seed de Cortes em repositório vazio cria três planos, sem escrita na repetição", async () => {
  const linhas = new Map<string, Record<string, unknown>>();
  let escritas = 0;
  const repo: RepositorioDePlanos = {
    buscar: async id => linhas.get(id) ?? null,
    criar: async plano => { escritas++; linhas.set(plano.id, { ...plano }); },
  };
  await semearPlanosComerciais(repo, PLANOS_CORTES);
  await semearPlanosComerciais(repo, PLANOS_CORTES);
  assert.equal(escritas, 3);
  assert.deepEqual([...linhas.keys()], PLANOS_CORTES.map(p => p.id));
});

for (const [indice, plano] of PLANOS_CORTES.entries()) {
  test(`${plano.nome}: uma assinatura autoriza assistir, cortes e download completo`, async () => {
    const ent = resolverEntitlements({ agora, candidatas: [assinatura(plano)], planoPadrao: PLANO_GRATUITO });
    const resolver = async () => ent;
    assert.equal(ent.assinatura.planoId, plano.id);
    for (const tipo of ["filme", "serie"] as const) {
      assert.deepEqual(await autorizarCatalogo("u", tipo, { ativa: true, resolver }), { situacao: "permitido", via: "direito" });
    }
    assert.equal(await downloadPermitido("u", "individual", { controleAtivo: true, resolver }), true);
    assert.equal(await downloadPermitido("u", "lote", { controleAtivo: true, resolver }), indice > 0);
    // Download completo é de todo plano; o que varia é o anúncio, que segue o plano.
    assert.equal(await downloadPermitido("u", "completo", { controleAtivo: true, resolver }), true);
    assert.equal(ent.direitos.anunciosObrigatorios, plano.anunciosObrigatorios);
    const vencida = { ...assinatura(plano), terminaEm: agora };
    const expirada = resolverEntitlements({ agora, candidatas: [vencida], planoPadrao: PLANO_GRATUITO });
    assert.equal(expirada.assinatura.ativa, false);
    assert.equal(expirada.direitos.cortesNivel, "nenhum");
    assert.equal(await downloadPermitido("u", "individual", { controleAtivo: true, resolver: async () => expirada }), false);
  });
}

test("assinaturas antigas mantêm direitos; duas assinaturas válidas continuam recusadas", () => {
  for (const plano of PLANOS_COMERCIAIS) {
    const ent = resolverEntitlements({ agora, candidatas: [assinatura(plano)], planoPadrao: PLANO_GRATUITO });
    assert.equal(ent.direitos.downloads, plano.downloads);
    assert.equal(ent.direitos.cortesNivel, "nenhum");
  }
  // Famílias diferentes somam; duas da mesma família continuam recusadas.
  const somadas = resolverEntitlements({
    agora, planoPadrao: PLANO_GRATUITO,
    candidatas: [assinatura(PLANO_BASIC), { ...assinatura(PLANOS_CORTES[0]), id: "outra" }],
  });
  assert.equal(somadas.assinatura.planoId, PLANO_BASIC.id);
  assert.equal(somadas.direitos.cortesNivel, PLANOS_CORTES[0].cortesNivel);
  assert.throws(() => resolverEntitlements({
    agora, planoPadrao: PLANO_GRATUITO,
    candidatas: [assinatura(PLANOS_CORTES[0]), { ...assinatura(PLANOS_CORTES[1]), id: "outra" }],
  }), e => e instanceof EntitlementsIndefinidos && e.motivo === "assinaturas_ambiguas");
  assert.deepEqual(planejarAtivacao(
    { operacao: "nova", duracao: { tipo: "dias", dias: 30 } },
    [{ id: "legada", terminaEm: new Date("2026-11-01T12:00:00Z") }], agora,
  ), { ok: false, motivo: "periodo_em_aberto" });
});

for (const plano of PLANOS_CORTES) {
  test(`checkout ${plano.id}: sem preço, preço inativo, plano inativo e preço alheio não cobram`, async () => {
    // Valor só do dublê: não é catálogo ou proposta comercial.
    const preco: PrecoDoBanco = { id: "teste", planoId: plano.id, plano,
      rotulo: "Teste", ativo: true, precoCentavos: 123, duracaoDias: 30, moeda: "BRL" };
    const cenarios: [PrecoDoBanco | null, string][] = [
      [null, "preco_inexistente"], [{ ...preco, ativo: false }, "preco_inativo"],
      [preco, "plano_inativo"],
      [{ ...preco, planoId: PLANO_BASIC.id, plano: PLANO_BASIC }, "plano_divergente"],
    ];
    for (const [linha, motivo] of cenarios) {
      const proibido = async (): Promise<never> => { assert.fail("não deve gravar, consultar períodos ou cobrar"); };
      const repo: RepositorioDePedidos = {
        buscarPreco: async () => linha, revisaoPendente: async () => false,
        buscarAdicionais: proibido, periodosEmAberto: proibido, criar: proibido,
        registrarVenda: proibido, registrarFalha: proibido,
      };
      const r = await criarPedidoPix({ userId: "u", planoId: plano.id, planoPrecoId: "teste",
        pagador: { nome: "Teste", email: "teste@example.test", telefone: "11999999999", documento: { numero: "12345678901", tipo: "cpf" } },
      }, { repo, provedor: { criarVenda: proibido } });
      assert.deepEqual(r, { situacao: "nao_compravel", motivo });
    }
  });
}

test("preços oficiais dos Cortes: só com valores explícitos, Pro acima do Start, AI recusado, simulação por padrão", async () => {
  const { lerPrecosOficiais } = await import("../../../scripts/cortes-precos-oficiais");
  assert.deepEqual(lerPrecosOficiais(["--start=1990", "--pro=2990"]), {
    aplicar: false,
    precos: [
      { planoId: "cortes-start", precoCentavos: 1990, duracaoDias: 30 },
      { planoId: "cortes-pro", precoCentavos: 2990, duracaoDias: 30 },
    ],
  });
  assert.equal(lerPrecosOficiais(["--start=1990", "--pro=2990", "--aplicar"]).aplicar, true);
  for (const ruim of [[], ["--start=1990"], ["--start=0", "--pro=2990"], ["--start=19.9", "--pro=2990"], ["--start=2990", "--pro=1990"], ["--start=1990", "--pro=2990", "--ai=3990"]]) {
    assert.throws(() => lerPrecosOficiais(ruim), JSON.stringify(ruim));
  }
});
