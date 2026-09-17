import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classificarOperacao,
  fimDoPeriodo,
  mesesCobraveis,
  somarMesesCalendario,
  valorNaoUtilizado,
  type PeriodoPago,
} from "../billing/vigencia";
import { TELAS_ADICIONAIS_MAX, calcularTotal } from "../billing/precificacao";

/** Instante a partir do relógio de Brasília (UTC−3). */
const brt = (iso: string) => new Date(`${iso}-03:00`);

describe("meses de calendário", () => {
  test("mesmo dia no mês final, horário preservado", () => {
    assert.equal(somarMesesCalendario(brt("2026-03-15T10:30:00"), 5).toISOString(), brt("2026-08-15T10:30:00").toISOString());
    assert.equal(somarMesesCalendario(brt("2026-03-15T10:30:00"), 12).toISOString(), brt("2027-03-15T10:30:00").toISOString());
  });

  test("dia inexistente no mês final vira o último dia daquele mês", () => {
    assert.equal(somarMesesCalendario(brt("2026-01-31T08:00:00"), 1).toISOString(), brt("2026-02-28T08:00:00").toISOString());
    assert.equal(somarMesesCalendario(brt("2027-09-30T08:00:00"), 5).toISOString(), brt("2028-02-29T08:00:00").toISOString(), "bissexto");
    assert.equal(somarMesesCalendario(brt("2026-10-31T23:59:00"), 5).toISOString(), brt("2027-03-31T23:59:00").toISOString());
    assert.equal(somarMesesCalendario(brt("2028-02-29T12:00:00"), 12).toISOString(), brt("2029-02-28T12:00:00").toISOString());
  });

  test("o dia é o de Brasília, não o de UTC", () => {
    // 31/01 22:00 em Brasília já é 01/02 em UTC. O fim precisa ser 28/02 em Brasília.
    const inicio = brt("2026-01-31T22:00:00");
    assert.equal(inicio.getUTCDate(), 1);
    assert.equal(somarMesesCalendario(inicio, 1).toISOString(), brt("2026-02-28T22:00:00").toISOString());
  });

  test("virada de ano e valores inválidos", () => {
    assert.equal(somarMesesCalendario(brt("2026-11-30T00:00:00"), 5).toISOString(), brt("2027-04-30T00:00:00").toISOString());
    for (const meses of [0, -1, 1.5, 25]) assert.throws(() => somarMesesCalendario(brt("2026-01-01T00:00:00"), meses));
    assert.throws(() => somarMesesCalendario(new Date("x"), 1));
  });

  test("fim do período: dias somam dias, meses somam calendário", () => {
    const inicio = brt("2026-01-31T00:00:00");
    assert.equal(fimDoPeriodo(inicio, { tipo: "dias", dias: 30 }).toISOString(), brt("2026-03-02T00:00:00").toISOString());
    assert.equal(fimDoPeriodo(inicio, { tipo: "meses", meses: 1 }).toISOString(), brt("2026-02-28T00:00:00").toISOString());
  });

  test("meses cobráveis de adicional: 30 dias = 1; outros dias não têm equivalência", () => {
    assert.equal(mesesCobraveis({ tipo: "dias", dias: 30 }), 1);
    assert.equal(mesesCobraveis({ tipo: "meses", meses: 5 }), 5);
    assert.equal(mesesCobraveis({ tipo: "meses", meses: 12 }), 12);
    assert.equal(mesesCobraveis({ tipo: "dias", dias: 31 }), null);
    assert.equal(mesesCobraveis({ tipo: "meses", meses: 0 }), null);
  });
});

const agora = brt("2026-06-15T12:00:00");
const periodo = (p: Partial<PeriodoPago>): PeriodoPago => ({
  id: "a1", planoId: "plus", ordemDoPlano: 2,
  iniciaEm: brt("2026-06-01T12:00:00"), terminaEm: brt("2026-07-01T12:00:00"),
  valorPagoCentavos: 1990, ...p,
});

describe("operação da compra", () => {
  test("sem período em aberto: nova, a partir de agora", () => {
    assert.deepEqual(classificarOperacao({ periodos: [], plano: { id: "plus", ordem: 2 }, agora }), { tipo: "nova", iniciaEm: agora });
    const vencido = periodo({ terminaEm: brt("2026-06-10T00:00:00") });
    assert.equal(classificarOperacao({ periodos: [vencido], plano: { id: "plus", ordem: 2 }, agora }).tipo, "nova");
  });

  test("mesmo plano: renovação soma ao vencimento atual", () => {
    const op = classificarOperacao({ periodos: [periodo({})], plano: { id: "plus", ordem: 2 }, agora });
    assert.deepEqual(op, { tipo: "renovacao", iniciaEm: brt("2026-07-01T12:00:00") });
  });

  test("renovação encadeia depois do último período já agendado", () => {
    const agendado = periodo({ id: "a2", iniciaEm: brt("2026-07-01T12:00:00"), terminaEm: brt("2026-08-01T12:00:00") });
    const op = classificarOperacao({ periodos: [agendado, periodo({})], plano: { id: "plus", ordem: 2 }, agora });
    assert.deepEqual(op, { tipo: "renovacao", iniciaEm: brt("2026-08-01T12:00:00") });
  });

  test("plano inferior: downgrade só no fim do período pago", () => {
    const op = classificarOperacao({ periodos: [periodo({})], plano: { id: "basic", ordem: 1 }, agora });
    assert.deepEqual(op, { tipo: "downgrade", iniciaEm: brt("2026-07-01T12:00:00") });
  });

  test("plano superior: upgrade imediato substituindo o que está em aberto", () => {
    const agendado = periodo({ id: "a2", iniciaEm: brt("2026-07-01T12:00:00"), terminaEm: brt("2026-08-01T12:00:00") });
    const op = classificarOperacao({ periodos: [periodo({}), agendado], plano: { id: "premium", ordem: 3 }, agora });
    assert.deepEqual(op, { tipo: "upgrade", iniciaEm: agora, substitui: ["a1", "a2"] });
  });

  test("a escada é Plano.ordem, não o id", () => {
    const op = classificarOperacao({ periodos: [periodo({ planoId: "x", ordemDoPlano: 5 })], plano: { id: "premium", ordem: 3 }, agora });
    assert.equal(op.tipo, "downgrade");
  });
});

describe("valor não utilizado", () => {
  test("proporcional ao tempo restante, arredondado para baixo", () => {
    // 30 dias pagos, 14 dias usados: restam 16/30 de 1990 = 1061,33 → 1061.
    assert.equal(valorNaoUtilizado(periodo({}), agora), 1061);
  });

  test("período futuro vale inteiro; encerrado vale zero", () => {
    const futuro = periodo({ iniciaEm: brt("2026-07-01T12:00:00"), terminaEm: brt("2026-08-01T12:00:00") });
    assert.equal(valorNaoUtilizado(futuro, agora), 1990);
    assert.equal(valorNaoUtilizado(periodo({ terminaEm: brt("2026-06-10T00:00:00") }), agora), 0);
  });

  test("valor ou intervalo inválido não gera crédito", () => {
    assert.equal(valorNaoUtilizado(periodo({ valorPagoCentavos: 0 }), agora), 0);
    assert.equal(valorNaoUtilizado(periodo({ valorPagoCentavos: 19.9 }), agora), 0);
    assert.equal(valorNaoUtilizado(periodo({ iniciaEm: brt("2026-07-01T12:00:00"), terminaEm: brt("2026-06-01T12:00:00") }), agora), 0);
  });
});

describe("total da compra", () => {
  const adicionaisPlus = { telaMensalCentavos: 995, servidorVipMensalCentavos: null };
  const adicionaisBasico = { telaMensalCentavos: 1000, servidorVipMensalCentavos: 590 };

  test("sem adicionais: o preço do plano", () => {
    const r = calcularTotal({
      precoPlanoCentavos: 1990, duracao: { tipo: "dias", dias: 30 }, telasAdicionais: 0, servidorVip: false,
      planoIncluiServidorVip: true, servidorVipOfertado: false, adicionais: adicionaisPlus,
    });
    assert.deepEqual(r, { ok: true, meses: 1, baseCentavos: 1990, telasCentavos: 0, servidorVipCentavos: 0, totalCentavos: 1990 });
  });

  test("telas extras: preço mensal × telas × meses da duração", () => {
    const r = calcularTotal({
      precoPlanoCentavos: 8990, duracao: { tipo: "meses", meses: 5 }, telasAdicionais: 2, servidorVip: false,
      planoIncluiServidorVip: true, servidorVipOfertado: false, adicionais: adicionaisPlus,
    });
    assert.deepEqual(r, { ok: true, meses: 5, baseCentavos: 8990, telasCentavos: 9950, servidorVipCentavos: 0, totalCentavos: 18940 });
  });

  test("no máximo 2 telas adicionais", () => {
    assert.equal(TELAS_ADICIONAIS_MAX, 2);
    const r = calcularTotal({
      precoPlanoCentavos: 1000, duracao: { tipo: "dias", dias: 30 }, telasAdicionais: 3, servidorVip: false,
      planoIncluiServidorVip: false, servidorVipOfertado: false, adicionais: adicionaisBasico,
    });
    assert.deepEqual(r, { ok: false, codigo: "telas_acima_do_limite" });
  });

  test("VIP avulso fora da oferta enquanto o direito não existir", () => {
    const r = calcularTotal({
      precoPlanoCentavos: 1000, duracao: { tipo: "dias", dias: 30 }, telasAdicionais: 0, servidorVip: true,
      planoIncluiServidorVip: false, servidorVipOfertado: false, adicionais: adicionaisBasico,
    });
    assert.deepEqual(r, { ok: false, codigo: "adicional_indisponivel" });
  });

  test("VIP avulso ofertado: R$ 5,90 por mês na duração inteira; recusado se o plano já inclui", () => {
    const base = {
      precoPlanoCentavos: 9590, duracao: { tipo: "meses", meses: 12 } as const, telasAdicionais: 0, servidorVip: true,
      servidorVipOfertado: true, adicionais: adicionaisBasico,
    };
    assert.deepEqual(calcularTotal({ ...base, planoIncluiServidorVip: false }), {
      ok: true, meses: 12, baseCentavos: 9590, telasCentavos: 0, servidorVipCentavos: 7080, totalCentavos: 16670,
    });
    assert.deepEqual(calcularTotal({ ...base, planoIncluiServidorVip: true }), { ok: false, codigo: "servidor_vip_ja_incluso" });
  });

  test("adicional sem preço ativo e duração sem equivalência são recusados", () => {
    const semPreco = calcularTotal({
      precoPlanoCentavos: 1000, duracao: { tipo: "dias", dias: 30 }, telasAdicionais: 1, servidorVip: false,
      planoIncluiServidorVip: false, servidorVipOfertado: false, adicionais: { telaMensalCentavos: null, servidorVipMensalCentavos: null },
    });
    assert.deepEqual(semPreco, { ok: false, codigo: "adicional_indisponivel" });
    // Duração em dias sem meses cobráveis: comprável sem adicional, recusada com adicional.
    const diasSemAdicional = calcularTotal({
      precoPlanoCentavos: 1000, duracao: { tipo: "dias", dias: 45 }, telasAdicionais: 0, servidorVip: false,
      planoIncluiServidorVip: false, servidorVipOfertado: false, adicionais: adicionaisBasico,
    });
    assert.equal(diasSemAdicional.ok && diasSemAdicional.totalCentavos, 1000);
    const diasComTela = calcularTotal({
      precoPlanoCentavos: 1000, duracao: { tipo: "dias", dias: 45 }, telasAdicionais: 1, servidorVip: false,
      planoIncluiServidorVip: false, servidorVipOfertado: false, adicionais: adicionaisBasico,
    });
    assert.deepEqual(diasComTela, { ok: false, codigo: "duracao_invalida" });
  });
});
