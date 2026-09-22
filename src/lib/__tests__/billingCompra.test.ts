import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { montarCompra, type SnapshotDeCompra } from "../billing/pedidos";
import { duracaoDoPedido, planejarAtivacao } from "../billing/confirmacao";
import { resolverEntitlements, reviverEntitlements, type AssinaturaCandidata } from "../entitlements";
import { PLANO_BASIC, PLANO_GRATUITO, PLANO_PLUS } from "../planos";
import type { PeriodoPago } from "../billing/vigencia";

/**
 * Renovação, upgrade com crédito, downgrade agendado e adicionais: da compra à
 * ativação e aos direitos.
 */

const brt = (iso: string) => new Date(`${iso}-03:00`);
const agora = brt("2026-06-15T12:00:00");

const snapshot = (over: Partial<SnapshotDeCompra> = {}): SnapshotDeCompra => ({
  planoId: "plus", planoPrecoId: "pp", valorCentavos: 1990, moeda: "BRL",
  duracaoDias: 30, duracaoMeses: null, descricao: "Plus — 30 dias", ...over,
});

const periodo = (over: Partial<PeriodoPago> = {}): PeriodoPago => ({
  id: "a1", planoId: "basic", ordemDoPlano: 1,
  iniciaEm: brt("2026-06-01T12:00:00"), terminaEm: brt("2026-07-01T12:00:00"),
  valorPagoCentavos: 1000, ...over,
});

const semAdicionais = { telaMensalCentavos: null, servidorVipMensalCentavos: null };
const adicionaisPlus = { telaMensalCentavos: 995, servidorVipMensalCentavos: null };

const montar = (over: Partial<Parameters<typeof montarCompra>[0]> = {}) =>
  montarCompra({
    snapshot: snapshot(), plano: { ordem: 2, servidorVip: true }, adicionais: semAdicionais,
    telasAdicionais: 0, servidorVip: false, periodos: [], agora, ...over,
  });

describe("montarCompra", () => {
  test("nova: preço do plano, sem crédito, começa agora", () => {
    const r = montar();
    assert.ok(r.ok);
    assert.equal(r.compra.operacao, "nova");
    assert.equal(r.compra.snapshot.valorCentavos, 1990);
    assert.equal(r.compra.creditoCentavos, 0);
    assert.equal(r.compra.iniciaEmPrevisto.getTime(), agora.getTime());
  });

  test("telas adicionais: mensal × meses, somadas ao valor cobrado", () => {
    const r = montar({
      snapshot: snapshot({ valorCentavos: 8990, duracaoDias: null, duracaoMeses: 5 }),
      adicionais: adicionaisPlus, telasAdicionais: 2,
    });
    assert.ok(r.ok);
    assert.deepEqual(
      [r.compra.valorPlanoCentavos, r.compra.valorAdicionaisCentavos, r.compra.snapshot.valorCentavos],
      [8990, 9950, 18940],
    );
  });

  test("mais de 2 telas, tela sem preço e VIP avulso fora da oferta são recusados", () => {
    assert.deepEqual(montar({ adicionais: adicionaisPlus, telasAdicionais: 3 }), { ok: false, codigo: "telas_acima_do_limite" });
    assert.deepEqual(montar({ telasAdicionais: 1 }), { ok: false, codigo: "adicional_indisponivel" });
    assert.deepEqual(
      montar({ plano: { ordem: 1, servidorVip: false }, adicionais: { telaMensalCentavos: 1000, servidorVipMensalCentavos: 590 }, servidorVip: true }),
      { ok: false, codigo: "adicional_indisponivel" },
    );
  });

  test("VIP avulso quando ofertado: R$ 5,90 × meses; recusado se o plano já inclui", () => {
    const basico12 = snapshot({ planoId: "basic", valorCentavos: 9590, duracaoDias: null, duracaoMeses: 12 });
    const r = montar({
      snapshot: basico12, plano: { ordem: 1, servidorVip: false },
      adicionais: { telaMensalCentavos: 1000, servidorVipMensalCentavos: 590 }, servidorVip: true, servidorVipOfertado: true,
    });
    assert.ok(r.ok);
    assert.equal(r.compra.snapshot.valorCentavos, 9590 + 7080);
    assert.deepEqual(
      montar({ servidorVip: true, servidorVipOfertado: true, adicionais: { telaMensalCentavos: null, servidorVipMensalCentavos: 590 } }),
      { ok: false, codigo: "servidor_vip_ja_incluso" },
    );
  });

  test("renovação do mesmo plano: sem crédito, começa no vencimento atual", () => {
    const r = montar({ periodos: [periodo({ planoId: "plus", ordemDoPlano: 2 })] });
    assert.ok(r.ok);
    assert.equal(r.compra.operacao, "renovacao");
    assert.equal(r.compra.creditoCentavos, 0);
    assert.equal(r.compra.iniciaEmPrevisto.getTime(), brt("2026-07-01T12:00:00").getTime());
  });

  test("downgrade: sem crédito, começa ao fim do período pago", () => {
    const r = montar({
      snapshot: snapshot({ planoId: "basic", valorCentavos: 1000 }), plano: { ordem: 1, servidorVip: false },
      periodos: [periodo({ planoId: "plus", ordemDoPlano: 2, valorPagoCentavos: 1990 })],
    });
    assert.ok(r.ok);
    assert.equal(r.compra.operacao, "downgrade");
    assert.equal(r.compra.snapshot.valorCentavos, 1000);
    assert.equal(r.compra.iniciaEmPrevisto.getTime(), brt("2026-07-01T12:00:00").getTime());
  });

  test("upgrade: imediato, crédito proporcional descontado, substitui o vigente", () => {
    // Básico de 30 dias por R$ 10,00, 14 de 30 dias usados: crédito 1000 × 16/30 = 533.
    const plus12 = snapshot({ valorCentavos: 18990, duracaoDias: null, duracaoMeses: 12 });
    const r = montar({ snapshot: plus12, periodos: [periodo()] });
    assert.ok(r.ok);
    assert.equal(r.compra.operacao, "upgrade");
    assert.equal(r.compra.creditoCentavos, 533);
    assert.equal(r.compra.snapshot.valorCentavos, 18990 - 533);
    assert.deepEqual(r.compra.assinaturasSubstituidas, ["a1"]);
    assert.equal(r.compra.iniciaEmPrevisto.getTime(), agora.getTime());
  });

  test("upgrade com período agendado: o agendado entra inteiro no crédito", () => {
    const agendado = periodo({ id: "a2", iniciaEm: brt("2026-07-01T12:00:00"), terminaEm: brt("2026-08-01T12:00:00") });
    const r = montar({ snapshot: snapshot({ valorCentavos: 18990, duracaoDias: null, duracaoMeses: 12 }), periodos: [periodo(), agendado] });
    assert.ok(r.ok);
    assert.equal(r.compra.creditoCentavos, 533 + 1000);
    assert.deepEqual(r.compra.assinaturasSubstituidas.sort(), ["a1", "a2"]);
  });

  test("crédito maior ou igual à compra: exige duração que o cubra", () => {
    // Básico de 1 ano quase inteiro → Plus 30 dias.
    const anual = periodo({ iniciaEm: brt("2026-06-10T12:00:00"), terminaEm: brt("2027-06-10T12:00:00"), valorPagoCentavos: 9590 });
    assert.deepEqual(montar({ periodos: [anual] }), { ok: false, codigo: "credito_maior_que_compra" });
    const r = montar({ snapshot: snapshot({ valorCentavos: 18990, duracaoDias: null, duracaoMeses: 12 }), periodos: [anual] });
    assert.ok(r.ok, "1 ano de Plus cobre o crédito");
  });

  test("período sem pagamento (cortesia) não gera crédito", () => {
    const r = montar({ periodos: [periodo({ valorPagoCentavos: 0 })] });
    assert.ok(r.ok);
    assert.equal(r.compra.creditoCentavos, 0);
  });

  test("duração ausente no snapshot é recusada", () => {
    assert.deepEqual(montar({ snapshot: snapshot({ duracaoDias: null, duracaoMeses: null }) }), { ok: false, codigo: "duracao_invalida" });
  });
});

describe("planejarAtivacao — recalculada na confirmação", () => {
  const mensal = { tipo: "dias", dias: 30 } as const;

  test("nova com período em aberto vai para revisão", () => {
    assert.deepEqual(
      planejarAtivacao({ operacao: "nova", duracao: mensal }, [{ id: "a1", terminaEm: brt("2026-07-01T12:00:00") }], agora),
      { ok: false, motivo: "periodo_em_aberto" },
    );
  });

  test("renovação começa no fim do último período; se ele venceu, agora", () => {
    const r = planejarAtivacao({ operacao: "renovacao", duracao: { tipo: "meses", meses: 1 } }, [{ id: "a1", terminaEm: brt("2026-07-31T12:00:00") }], agora);
    assert.ok(r.ok);
    assert.equal(r.iniciaEm.toISOString(), brt("2026-07-31T12:00:00").toISOString());
    assert.equal(r.terminaEm.toISOString(), brt("2026-08-31T12:00:00").toISOString());
    const vencido = planejarAtivacao({ operacao: "renovacao", duracao: mensal }, [], agora);
    assert.ok(vencido.ok);
    assert.equal(vencido.iniciaEm.getTime(), agora.getTime());
  });

  test("downgrade só vale depois do período pago", () => {
    const r = planejarAtivacao({ operacao: "downgrade", duracao: mensal }, [{ id: "a1", terminaEm: brt("2026-07-01T12:00:00") }], agora);
    assert.ok(r.ok);
    assert.equal(r.iniciaEm.toISOString(), brt("2026-07-01T12:00:00").toISOString());
    assert.deepEqual(r.cancelar, []);
  });

  test("upgrade cancela os períodos creditados; período desconhecido vai para revisão", () => {
    const abertos = [{ id: "a1", terminaEm: brt("2026-07-01T12:00:00") }];
    const r = planejarAtivacao({ operacao: "upgrade", assinaturasSubstituidas: ["a1"], duracao: mensal }, abertos, agora);
    assert.ok(r.ok);
    assert.deepEqual(r.cancelar, ["a1"]);
    assert.equal(r.iniciaEm.getTime(), agora.getTime());
    assert.deepEqual(
      planejarAtivacao({ operacao: "upgrade", assinaturasSubstituidas: ["a1"], duracao: mensal }, [...abertos, { id: "novo", terminaEm: brt("2026-09-01T12:00:00") }], agora),
      { ok: false, motivo: "substituicao_divergente" },
    );
  });

  test("meses de calendário na ativação: 31/01 + 1 mês termina no último dia de fevereiro", () => {
    const r = planejarAtivacao({ operacao: "nova", duracao: { tipo: "meses", meses: 1 } }, [], brt("2026-01-31T10:00:00"));
    assert.ok(r.ok);
    assert.equal(r.terminaEm.toISOString(), brt("2026-02-28T10:00:00").toISOString());
  });

  test("pedido antigo sem operação é tratado como compra nova; duração do snapshot", () => {
    assert.deepEqual(duracaoDoPedido({ duracaoDias: 30 }), { tipo: "dias", dias: 30 });
    assert.deepEqual(duracaoDoPedido({ duracaoDias: null, duracaoMeses: 5 }), { tipo: "meses", meses: 5 });
    assert.equal(duracaoDoPedido({}), null);
    const r = planejarAtivacao({ duracao: { tipo: "dias", dias: 30 } }, [], agora);
    assert.ok(r.ok);
  });
});

describe("direitos com adicionais", () => {
  const candidata = (over: Partial<AssinaturaCandidata>): AssinaturaCandidata => ({
    id: "a", status: "ATIVA", iniciaEm: brt("2026-06-01T00:00:00"), terminaEm: brt("2026-07-01T00:00:00"),
    plano: { ...PLANO_BASIC }, ...over,
  });
  const resolver = (c: AssinaturaCandidata) =>
    resolverEntitlements({ agora, candidatas: [c], planoPadrao: { ...PLANO_GRATUITO, ativo: true } });

  test("telas adicionais somam ao teto do plano: até 4", () => {
    assert.equal(resolver(candidata({ telasAdicionais: 2 })).direitos.telasMax, 4);
    assert.equal(resolver(candidata({ telasAdicionais: 1 })).direitos.telasMax, 3);
    assert.equal(resolver(candidata({})).direitos.telasMax, 2);
    assert.equal(resolver(candidata({ telasAdicionais: 9 })).direitos.telasMax, 2, "fora do domínio não vira tela");
  });

  test("VIP efetivo: incluso no plano OU adicional da assinatura", () => {
    assert.equal(resolver(candidata({})).direitos.servidorVip, false, "Básico sem adicional");
    assert.equal(resolver(candidata({ servidorVip: true })).direitos.servidorVip, true, "Básico com adicional");
    assert.equal(resolver(candidata({ plano: { ...PLANO_PLUS } })).direitos.servidorVip, true, "Plus incluso");
  });

  test("gratuito nunca recebe VIP", () => {
    const r = resolverEntitlements({ agora, candidatas: [], planoPadrao: { ...PLANO_GRATUITO, ativo: true } });
    assert.equal(r.direitos.servidorVip, false);
  });

  test("cache de formato antigo, sem servidorVip, vira miss", () => {
    const atual = resolver(candidata({ servidorVip: true }));
    assert.ok(reviverEntitlements(JSON.stringify(atual)));
    const antigo = JSON.parse(JSON.stringify(atual));
    delete antigo.direitos.servidorVip;
    assert.equal(reviverEntitlements(JSON.stringify(antigo)), null);
  });
});

describe("migration 20260913 — criada e não aplicada", () => {
  const sql = readFileSync("prisma/migrations/20260913_duracoes_adicionais_vip/migration.sql", "utf8");
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  test("transacional, com aviso de não aplicada", () => {
    assert.ok(sql.includes("BEGIN;") && sql.trimEnd().endsWith("COMMIT;"));
    assert.ok(sql.includes("NAO FOI APLICADA"));
  });

  test("CHECKs das regras aprovadas", () => {
    assert.ok(sql.includes('CHECK ("telasAdicionais" BETWEEN 0 AND 2)'));
    assert.ok(sql.includes("\"duracaoMeses\" BETWEEN 1 AND 24"));
    assert.ok(sql.includes("CHECK (\"operacao\" IN ('nova', 'renovacao', 'upgrade', 'downgrade'))"));
    assert.ok(sql.includes("CHECK (\"tipo\" IN ('tela', 'servidor_vip'))"));
    assert.ok(sql.includes('"valorCentavos" = "valorPlanoCentavos" + "valorAdicionaisCentavos" - "creditoCentavos"'));
    assert.ok(sql.includes("CHECK (\"creditoCentavos\" = 0 OR \"operacao\" = 'upgrade')"));
    assert.ok(sql.includes('ALTER TABLE "PlanoAdicionalPreco" ENABLE ROW LEVEL SECURITY;'));
  });

  test("schema Prisma declara as mesmas colunas", () => {
    for (const trecho of [
      "servidorVip Boolean @default(false)", "duracaoMeses Int?", "model PlanoAdicionalPreco",
      "telasAdicionais Int @default(0)", "creditoCentavos         Int  @default(0)",
      "assinaturasSubstituidas String[] @default([])",
    ]) {
      assert.ok(schema.includes(trecho), trecho);
    }
  });
});
