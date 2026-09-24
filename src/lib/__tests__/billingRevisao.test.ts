import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

import { calcularTotal } from "../billing/precificacao";
import { fimDoPeriodo, proporcaoParaBaixo, valorNaoUtilizado } from "../billing/vigencia";
import { MENSAGEM_DE_REVISAO_AO_COMPRADOR, motivoDaConfirmacao } from "../billing/revisao";
import {
  OBSERVACAO_DE_SUBSTITUICAO,
  executarAcaoDeRevisao,
  planejarResolucao,
  type PedidoEmRevisao,
} from "../billing/revisaoAcoes";
import { criarPedidoPix, type DadosDoPagador, type PrecoDoBanco, type RepositorioDePedidos } from "../billing/pedidos";
import { confirmarPedidoPorId } from "../billing/confirmacao";
import { mensagemErroCheckout } from "../billing/checkout";
import { criarFake, pedido as pedidoBase } from "./helpers/billingConfirmacaoFake";
import { GET as pendingGet } from "../../app/api/billing/orders/pending/route";
import { GET as pedidoGet } from "../../app/api/billing/orders/[id]/route";
import { GET as listarRevisoesGet } from "../../app/api/admin/pagamentos/revisoes/route";
import { POST as acaoRevisaoPost } from "../../app/api/admin/pagamentos/revisoes/[id]/route";

/**
 * Regras comerciais aprovadas em 2026-09-14 e o fluxo mínimo de revisão manual.
 */

const AGORA = new Date("2026-09-10T12:00:00.000Z");
const DIA = 86_400_000;

// ── 1. Regras comerciais ─────────────────────────────────────────────────────

describe("adicionais: mensalidades por duração", () => {
  const base = {
    precoPlanoCentavos: 1000,
    telasAdicionais: 2,
    servidorVip: false,
    planoIncluiServidorVip: false,
    servidorVipOfertado: false,
    adicionais: { telaMensalCentavos: 995, servidorVipMensalCentavos: 590 },
  };

  test("30 dias = 1 mensalidade; 5 meses = 5; 1 ano = 12", () => {
    const casos: [Parameters<typeof calcularTotal>[0]["duracao"], number][] = [
      [{ tipo: "dias", dias: 30 }, 1],
      [{ tipo: "meses", meses: 5 }, 5],
      [{ tipo: "meses", meses: 12 }, 12],
    ];
    for (const [duracao, mensalidades] of casos) {
      const r = calcularTotal({ ...base, duracao });
      assert.ok(r.ok);
      assert.equal(r.meses, mensalidades);
      assert.equal(r.telasCentavos, 995 * 2 * mensalidades);
    }
  });

  test("VIP avulso, quando ofertado, segue as mesmas mensalidades", () => {
    for (const [duracao, n] of [[{ tipo: "dias", dias: 30 }, 1], [{ tipo: "meses", meses: 5 }, 5], [{ tipo: "meses", meses: 12 }, 12]] as const) {
      const r = calcularTotal({ ...base, telasAdicionais: 0, servidorVip: true, servidorVipOfertado: true, duracao });
      assert.ok(r.ok);
      assert.equal(r.servidorVipCentavos, 590 * n);
    }
  });

  test("a equivalência não altera a validade: 30 dias são 30 × 24 h; meses são de calendário", () => {
    const inicio = new Date("2026-01-31T15:00:00.000Z");
    assert.equal(fimDoPeriodo(inicio, { tipo: "dias", dias: 30 }).getTime() - inicio.getTime(), 30 * DIA);
    // Um mês de calendário a partir de 31/01 termina no último dia de fevereiro — não em 30 dias.
    assert.equal(fimDoPeriodo(inicio, { tipo: "meses", meses: 1 }).toISOString(), "2026-02-28T15:00:00.000Z");
    // E 30 dias não é tratado como "1 mês" na validade.
    assert.notEqual(
      fimDoPeriodo(inicio, { tipo: "dias", dias: 30 }).getTime(),
      fimDoPeriodo(inicio, { tipo: "meses", meses: 1 }).getTime(),
    );
  });
});

describe("crédito de upgrade: inteiro exato, para baixo em centavos", () => {
  test("definição de piso verificada em aritmética inteira, inclusive acima de 2^53", () => {
    const casos: [number, number, number][] = [
      [1000, 16 * DIA, 30 * DIA],
      [28490, 31_535_999_999, 31_536_000_000],
      [123_456_789, 98_765_432_109, 98_765_432_111],
      [9_007_199_254, 9_007_199_254_740, 9_007_199_254_741],
      [3, 1, 3],
      [1, 1, 1],
    ];
    for (const [valor, parte, total] of casos) {
      const r = BigInt(proporcaoParaBaixo(valor, parte, total));
      const produto = BigInt(valor) * BigInt(parte);
      assert.ok(r * BigInt(total) <= produto, `${valor}×${parte}/${total} não pode passar do exato`);
      assert.ok(produto < (r + BigInt(1)) * BigInt(total), `${valor}×${parte}/${total} não pode ficar um centavo abaixo do piso`);
    }
  });

  test("um milissegundo usado já tira o centavo: arredonda para baixo, nunca para o valor cheio", () => {
    const periodo = { id: "a", planoId: "basic", ordemDoPlano: 1, iniciaEm: new Date(AGORA.getTime() - 1), terminaEm: new Date(AGORA.getTime() - 1 + 30 * DIA), valorPagoCentavos: 1000 };
    assert.equal(valorNaoUtilizado(periodo, AGORA), 999);
  });

  test("16 de 30 dias restantes de R$ 10,00: 533 centavos", () => {
    const periodo = { id: "a", planoId: "basic", ordemDoPlano: 1, iniciaEm: new Date(AGORA.getTime() - 14 * DIA), terminaEm: new Date(AGORA.getTime() + 16 * DIA), valorPagoCentavos: 1000 };
    assert.equal(valorNaoUtilizado(periodo, AGORA), 533);
  });

  test("entradas fora do domínio não geram crédito nem exceção silenciosa", () => {
    const base = { id: "a", planoId: "basic", ordemDoPlano: 1, iniciaEm: new Date(AGORA.getTime() - DIA), terminaEm: new Date(AGORA.getTime() + DIA) };
    assert.equal(valorNaoUtilizado({ ...base, valorPagoCentavos: 10.5 }, AGORA), 0);
    assert.equal(valorNaoUtilizado({ ...base, valorPagoCentavos: 0 }, AGORA), 0);
    assert.throws(() => proporcaoParaBaixo(1, 1, 0), /proporcao_invalida/);
  });
});

describe("estorno de upgrade na confirmação", () => {
  const refunded = async () => ({ ok: true as const, confirmacao: { transactionId: "tx", status: "REFUNDED" as const, amount: 1000, paidAt: null } });

  function cenarioUpgrade() {
    const velha = { id: "velha", status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO("p"), terminaEm: new Date(AGORA.getTime() + 10 * DIA) };
    const estado: any = {
      pedido: { ...pedidoBase("PAGO"), operacao: "upgrade", assinaturasSubstituidas: ["velha"], assinatura: { id: "a", status: "ATIVA", pedidoId: "p" } },
      ativas: [velha],
    };
    return { estado, velha, fake: criarFake(estado) };
  }

  test("registra o estorno já, cancela o direito do pedido e abre revisão sem restaurar nada", async () => {
    process.env.BLACKCAT_CONFIRMACAO_ATIVA = "true";
    const { estado, velha, fake } = cenarioUpgrade();
    await confirmarPedidoPorId("p", { prisma: fake.banco, consultarStatusBlackcat: refunded, invalidarEntitlements: fake.invalidar, agora: fake.agora });

    assert.equal(estado.pedido.status, "ESTORNADO");
    assert.equal(estado.pedido.assinatura.status, "CANCELADA");
    assert.equal(velha.status, "CANCELADA", "período substituído não é restaurado automaticamente");
    assert.deepEqual(estado.revisoes.map((r: any) => [r.motivo, r.status]), [["estorno_upgrade", "PENDENTE"]]);
    assert.deepEqual(fake.invalidacoes, ["u"]);
    assert.equal(JSON.stringify(estado).includes("saldo"), false, "nenhum saldo ou carteira");
  });

  test("notificação repetida não duplica o caso", async () => {
    process.env.BLACKCAT_CONFIRMACAO_ATIVA = "true";
    const { estado, fake } = cenarioUpgrade();
    for (let i = 0; i < 3; i++) {
      await confirmarPedidoPorId("p", { prisma: fake.banco, consultarStatusBlackcat: refunded, invalidarEntitlements: fake.invalidar, agora: fake.agora });
    }
    assert.equal(estado.revisoes.length, 1);
    assert.equal(estado.revisoes[0].status, "PENDENTE");
  });

  test("estorno de compra que não é upgrade não abre revisão", async () => {
    process.env.BLACKCAT_CONFIRMACAO_ATIVA = "true";
    const estado: any = { pedido: { ...pedidoBase("PAGO"), operacao: "nova", assinaturasSubstituidas: [], assinatura: { id: "a", status: "ATIVA", pedidoId: "p" } } };
    const fake = criarFake(estado);
    await confirmarPedidoPorId("p", { prisma: fake.banco, consultarStatusBlackcat: refunded, invalidarEntitlements: fake.invalidar, agora: fake.agora });
    assert.equal(estado.pedido.status, "ESTORNADO");
    assert.equal((estado.revisoes ?? []).length, 0);
  });

  test("divergência na confirmação abre caso com motivo em código interno", async () => {
    process.env.BLACKCAT_CONFIRMACAO_ATIVA = "true";
    const estado: any = { pedido: pedidoBase("AGUARDANDO") };
    const fake = criarFake(estado);
    const pago999 = async () => ({ ok: true as const, confirmacao: { transactionId: "tx", status: "PAID" as const, amount: 999, paidAt: null } });
    await confirmarPedidoPorId("p", { prisma: fake.banco, consultarStatusBlackcat: pago999, invalidarEntitlements: fake.invalidar, agora: fake.agora });
    assert.equal(estado.pedido.status, "REVISAO_MANUAL");
    assert.deepEqual(estado.revisoes.map((r: any) => r.motivo), ["confirmacao_divergente"]);
    assert.ok(estado.travas.includes("cobranca:u"), "abrir revisão trava a conta");
    assert.equal(fake.invalidacoes.length, 0);
  });

  test("compra nova paga com período em aberto vai para revisão, sem ativar", async () => {
    process.env.BLACKCAT_CONFIRMACAO_ATIVA = "true";
    const estado: any = { pedido: pedidoBase("AGUARDANDO"), ativas: [{ id: "x", terminaEm: new Date(AGORA.getTime() + DIA) }] };
    const fake = criarFake(estado);
    await confirmarPedidoPorId("p", { prisma: fake.banco, consultarStatusBlackcat: fake.consultar, invalidarEntitlements: fake.invalidar, agora: fake.agora });
    assert.equal(estado.pedido.status, "REVISAO_MANUAL");
    assert.equal(estado.pedido.assinatura, null);
    assert.deepEqual(estado.revisoes.map((r: any) => r.motivo), ["ativacao_periodo_em_aberto"]);
  });

  test("motivo da confirmação espelha a decisão", () => {
    const p = { status: "AGUARDANDO", valorCentavos: 1000, transacaoId: "tx", expiraEm: AGORA };
    const c = (o: object) => ({ transactionId: "tx", status: "PAID" as const, amount: 1000, paidAt: null, ...o });
    assert.equal(motivoDaConfirmacao(p, c({ amount: 1 }), AGORA), "confirmacao_divergente");
    assert.equal(motivoDaConfirmacao(p, c({ transactionId: "outra" }), AGORA), "confirmacao_divergente");
    assert.equal(motivoDaConfirmacao(p, c({}), AGORA), "pago_apos_expiracao");
    assert.equal(motivoDaConfirmacao({ ...p, expiraEm: null, status: "PAGO" }, c({}), AGORA), "pedido_em_estado_inesperado");
  });
});

// ── 2. Bloqueio de compras com revisão pendente ──────────────────────────────

const PRECO: PrecoDoBanco = {
  id: "pp", planoId: "plus", rotulo: "30 dias", precoCentavos: 1990, duracaoDias: 30, duracaoMeses: null,
  moeda: "BRL", ativo: true, plano: { id: "plus", nome: "Plus", ativo: true, ordem: 2, servidorVip: true },
};
const PAGADOR: DadosDoPagador = { nome: "Pessoa Ficticia", email: "pessoa@teste.obaflix.invalid", telefone: "11999999999", documento: { numero: "12345678901", tipo: "cpf" } };
const ENTRADA = { userId: "u", planoId: "plus", planoPrecoId: "pp", pagador: PAGADOR };

/** Banco em memória com a trava por conta simulada por uma fila. */
function bancoComTrava() {
  const revisoes = new Set<string>();
  const pedidos: string[] = [];
  let fila = Promise.resolve();
  const comTrava = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = fila.then(fn);
    fila = r.then(() => undefined, () => undefined);
    return r;
  };
  const repo: RepositorioDePedidos = {
    buscarPreco: async () => PRECO,
    buscarAdicionais: async () => ({ telaMensalCentavos: null, servidorVipMensalCentavos: null }),
    periodosEmAberto: async () => [],
    revisaoPendente: async (userId) => revisoes.has(userId),
    criar: (dados) => comTrava(async () => {
      if (revisoes.has(dados.userId)) return null;
      pedidos.push(dados.refExterna);
      return { id: `p-${pedidos.length}` };
    }),
    registrarVenda: async () => {},
    registrarFalha: async () => {},
  };
  const abrirRevisao = (userId: string) => comTrava(async () => { revisoes.add(userId); });
  return { repo, pedidos, abrirRevisao, revisoes };
}

function provedorContando() {
  let chamadas = 0;
  return {
    chamadas: () => chamadas,
    provedor: {
      criarVenda: async () => {
        chamadas++;
        return { ok: true as const, venda: { transacaoId: `tx-${chamadas}`, valorCentavos: 1990, expiraEm: new Date(AGORA.getTime() + 3600_000), qrCode: "q", copiaECola: "c", qrCodeBase64: null } };
      },
    },
  };
}

describe("compra com revisão pendente", () => {
  test("recusada antes de preço, pedido e provedor", async () => {
    const b = bancoComTrava();
    await b.abrirRevisao("u");
    const p = provedorContando();
    const r = await criarPedidoPix(ENTRADA, { repo: b.repo, provedor: p.provedor, gerarRef: () => "ref" });
    assert.deepEqual(r, { situacao: "revisao_pendente" });
    assert.equal(p.chamadas(), 0);
    assert.equal(b.pedidos.length, 0);
  });

  test("revisão aberta entre a checagem e a gravação: a gravação travada recusa", async () => {
    const b = bancoComTrava();
    const p = provedorContando();
    const repo = { ...b.repo, revisaoPendente: async () => { await b.abrirRevisao("u"); return false; } };
    const r = await criarPedidoPix(ENTRADA, { repo, provedor: p.provedor, gerarRef: () => "ref" });
    assert.deepEqual(r, { situacao: "revisao_pendente" });
    assert.equal(p.chamadas(), 0);
    assert.equal(b.pedidos.length, 0);
  });

  test("requisições simultâneas com revisão pendente: nenhuma chega ao provedor", async () => {
    const b = bancoComTrava();
    await b.abrirRevisao("u");
    const p = provedorContando();
    let n = 0;
    const resultados = await Promise.all(
      Array.from({ length: 8 }, () => criarPedidoPix(ENTRADA, { repo: b.repo, provedor: p.provedor, gerarRef: () => `ref-${++n}` })),
    );
    assert.ok(resultados.every((r) => r.situacao === "revisao_pendente"));
    assert.equal(p.chamadas(), 0);
  });

  test("revisão aberta durante uma rajada: toda gravação posterior à abertura é recusada", async () => {
    const b = bancoComTrava();
    const p = provedorContando();
    let n = 0;
    const compras = Array.from({ length: 6 }, (_, i) => i === 3
      ? b.abrirRevisao("u").then(() => null)
      : criarPedidoPix(ENTRADA, { repo: { ...b.repo, revisaoPendente: async () => false }, provedor: p.provedor, gerarRef: () => `ref-${++n}` }));
    const r = (await Promise.all(compras)).filter(Boolean) as { situacao: string }[];
    const criadas = r.filter((x) => x.situacao === "criado").length;
    assert.equal(criadas, b.pedidos.length);
    assert.equal(p.chamadas(), criadas, "provedor só para pedido gravado antes da revisão");
    assert.ok(r.some((x) => x.situacao === "revisao_pendente"));
  });

  test("a rota grava o pedido com a conta travada e rechecando a revisão na mesma transação", () => {
    const rota = readFileSync("src/app/api/billing/orders/route.ts", "utf8");
    const inicio = rota.indexOf("async criar(dados: NovoPedido)");
    const trecho = rota.slice(inicio, rota.indexOf("async registrarVenda"));
    const trava = trecho.indexOf("travarContaParaCobranca(tx");
    const checagem = trecho.indexOf("tx.revisaoPagamento.findFirst");
    const gravacao = trecho.indexOf("tx.pedidoPagamento.create");
    assert.ok(trecho.includes("prisma.$transaction("));
    assert.ok(trava > 0 && trava < checagem && checagem < gravacao, "trava → checagem → gravação");
    assert.ok(rota.includes('erro(409, "pagamento_em_revisao", MENSAGEM_DE_REVISAO_AO_COMPRADOR)'));
  });

  test("abrir revisão usa a mesma trava por conta", () => {
    const fonte = readFileSync("src/lib/billing/revisao.ts", "utf8");
    assert.ok(fonte.includes("pg_advisory_xact_lock(hashtextextended(${chave}, 0))"));
    assert.ok(fonte.includes("const chave = `cobranca:${userId}`"));
  });
});

// ── 3. Planejamento das ações ────────────────────────────────────────────────

function pedidoEm(over: Partial<PedidoEmRevisao> = {}): PedidoEmRevisao {
  return {
    id: "p", userId: "u", planoId: "plus", planoPrecoId: "pp", status: "REVISAO_MANUAL", valorCentavos: 1000,
    transacaoId: "tx", expiraEm: new Date(AGORA.getTime() + 3600_000), operacao: "nova", assinaturasSubstituidas: [],
    duracaoDias: 30, duracaoMeses: null, telasAdicionais: 0, servidorVip: false, ...over,
  };
}
const conf = (status: "PENDING" | "PAID" | "CANCELLED" | "REFUNDED", o: object = {}) => ({ transactionId: "tx", status, amount: 1000, paidAt: null, ...o });
const planejar = (o: Partial<Parameters<typeof planejarResolucao>[0]>) =>
  planejarResolucao({ acao: "ativar", pedido: pedidoEm(), assinaturaDoPedido: null, confirmacao: conf("PAID"), abertos: [], substituidas: [], agora: AGORA, ...o });

describe("planejarResolucao", () => {
  test("ativar só com PAID da mesma transação e do mesmo valor", () => {
    const ok = planejar({});
    assert.ok(ok.ok);
    assert.equal(ok.resolve, "ativada");
    assert.equal(ok.efeito.tipo, "ativar");

    assert.deepEqual(planejar({ confirmacao: null }), { ok: false, codigo: "provedor_indisponivel" });
    assert.deepEqual(planejar({ confirmacao: conf("PENDING") }), { ok: false, codigo: "pagamento_nao_confirmado" });
    assert.deepEqual(planejar({ confirmacao: conf("PAID", { transactionId: "outra" }) }), { ok: false, codigo: "transacao_divergente" });
    assert.deepEqual(planejar({ confirmacao: conf("PAID", { amount: 999 }) }), { ok: false, codigo: "valor_divergente" });
    assert.deepEqual(planejar({ assinaturaDoPedido: { id: "a", status: "ATIVA" } }), { ok: false, codigo: "pedido_ja_ativado" });
    assert.deepEqual(planejar({ pedido: pedidoEm({ status: "PAGO" }) }), { ok: false, codigo: "pedido_em_estado_incompativel" });
    assert.deepEqual(planejar({ abertos: [{ id: "x", terminaEm: new Date(AGORA.getTime() + DIA) }] }), { ok: false, codigo: "ativacao_periodo_em_aberto" });
  });

  test("confirmar estorno só com REFUNDED; upgrade mantém o caso aberto para recompor", () => {
    assert.deepEqual(planejar({ acao: "confirmar_estorno", confirmacao: conf("PAID") }), { ok: false, codigo: "estorno_nao_confirmado" });
    const simples = planejar({ acao: "confirmar_estorno", confirmacao: conf("REFUNDED"), pedido: pedidoEm({ status: "PAGO" }), assinaturaDoPedido: { id: "a", status: "ATIVA" } });
    assert.deepEqual(simples, { ok: true, efeito: { tipo: "estornar", cancelarAssinaturaId: "a" }, resolve: "estorno_confirmado" });
    const upgrade = planejar({ acao: "confirmar_estorno", confirmacao: conf("REFUNDED"), pedido: pedidoEm({ status: "PAGO", operacao: "upgrade" }) });
    assert.ok(upgrade.ok);
    assert.equal(upgrade.resolve, null);
    assert.equal(upgrade.novoMotivo, "estorno_upgrade");
  });

  test("confirmar não pago: cancelado, ou PIX vencido; PIX ainda válido é recusado", () => {
    assert.deepEqual(planejar({ acao: "confirmar_nao_pago", confirmacao: conf("CANCELLED") }), { ok: true, efeito: { tipo: "nao_pago", status: "CANCELADO" }, resolve: "nao_pago_confirmado" });
    const vencido = pedidoEm({ expiraEm: new Date(AGORA.getTime() - 1) });
    assert.deepEqual(planejar({ acao: "confirmar_nao_pago", confirmacao: conf("PENDING"), pedido: vencido }), { ok: true, efeito: { tipo: "nao_pago", status: "EXPIRADO" }, resolve: "nao_pago_confirmado" });
    assert.deepEqual(planejar({ acao: "confirmar_nao_pago", confirmacao: conf("PENDING") }), { ok: false, codigo: "pagamento_ainda_valido" });
    assert.deepEqual(planejar({ acao: "confirmar_nao_pago", confirmacao: conf("PAID") }), { ok: false, codigo: "pedido_em_estado_incompativel" });
  });

  describe("recompor upgrade estornado", () => {
    const estornado = pedidoEm({ status: "ESTORNADO", operacao: "upgrade", assinaturasSubstituidas: ["vigente", "vencida", "de-outro", "agendada"] });
    const futuro = new Date(AGORA.getTime() + 10 * DIA);
    const substituidas = [
      { id: "vigente", status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO("p"), terminaEm: futuro },
      { id: "agendada", status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO("p"), terminaEm: new Date(AGORA.getTime() + 40 * DIA) },
      { id: "vencida", status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO("p"), terminaEm: new Date(AGORA.getTime() - 1) },
      { id: "de-outro", status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO("outro-pedido"), terminaEm: futuro },
      { id: "nao-listada", status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO("p"), terminaEm: futuro },
    ];

    test("restaura só o que este pedido cancelou e ainda não terminou; nenhum crédito", () => {
      const r = planejar({ acao: "recompor_upgrade", pedido: estornado, confirmacao: conf("REFUNDED"), substituidas });
      assert.ok(r.ok);
      assert.deepEqual(r.efeito, { tipo: "recompor", restaurar: ["vigente", "agendada"], cancelarAssinaturaId: null });
      assert.equal(r.resolve, "upgrade_recomposto");
      assert.deepEqual(Object.keys(r.efeito).sort(), ["cancelarAssinaturaId", "restaurar", "tipo"]);
    });

    test("período já restaurado (ATIVA) não é restaurado de novo", () => {
      const jaRestaurada = substituidas.map((s) => (s.id === "vigente" ? { ...s, status: "ATIVA" } : s));
      // A vigente reativada aparece entre os períodos em aberto da conta: é
      // outro período em aberto, e a restauração vira decisão humana.
      const comReativada = planejar({
        acao: "recompor_upgrade", pedido: estornado, confirmacao: conf("REFUNDED"), substituidas: jaRestaurada,
        abertos: [{ id: "vigente", terminaEm: futuro }],
      });
      assert.deepEqual(comReativada, { ok: false, codigo: "conflito_com_periodo_atual" });
      // Sem período em aberto, só o que ainda está cancelado por este pedido é restaurado.
      const r2 = planejar({ acao: "recompor_upgrade", pedido: estornado, confirmacao: conf("REFUNDED"), substituidas: jaRestaurada, abertos: [] });
      assert.ok(r2.ok);
      assert.deepEqual(r2.ok && r2.efeito.tipo === "recompor" && r2.efeito.restaurar, ["agendada"]);
    });

    test("outro período em aberto torna a recomposição ambígua", () => {
      const r = planejar({ acao: "recompor_upgrade", pedido: estornado, confirmacao: conf("REFUNDED"), substituidas, abertos: [{ id: "compra-nova", terminaEm: futuro }] });
      assert.deepEqual(r, { ok: false, codigo: "conflito_com_periodo_atual" });
    });

    test("nada vigente para restaurar encerra sem inventar direito", () => {
      const r = planejar({ acao: "recompor_upgrade", pedido: estornado, confirmacao: conf("REFUNDED"), substituidas: [substituidas[2]] });
      assert.ok(r.ok);
      assert.equal(r.resolve, "upgrade_sem_periodo_restante");
    });

    test("exige estorno confirmado no provedor e pedido estornado", () => {
      assert.deepEqual(planejar({ acao: "recompor_upgrade", pedido: estornado, confirmacao: conf("PAID"), substituidas }), { ok: false, codigo: "estorno_nao_confirmado" });
      assert.deepEqual(planejar({ acao: "recompor_upgrade", pedido: { ...estornado, status: "PAGO" }, confirmacao: conf("REFUNDED"), substituidas }), { ok: false, codigo: "pedido_em_estado_incompativel" });
    });
  });

  test("encerrar sem alteração exige observação e pedido já em estado final", () => {
    assert.deepEqual(planejar({ acao: "encerrar_sem_alteracao", observacao: "curta" }), { ok: false, codigo: "observacao_obrigatoria" });
    assert.deepEqual(planejar({ acao: "encerrar_sem_alteracao", observacao: "verificado no painel do provedor" }), { ok: false, codigo: "pedido_em_estado_incompativel" });
    const ok = planejar({ acao: "encerrar_sem_alteracao", observacao: "verificado no painel do provedor", pedido: pedidoEm({ status: "ESTORNADO" }), confirmacao: null });
    assert.ok(ok.ok);
    assert.equal(ok.resolve, "encerrada_sem_alteracao");
  });

  test("reconsultar só registra o status do provedor", () => {
    assert.deepEqual(planejar({ acao: "reconsultar", confirmacao: conf("PENDING") }), { ok: true, efeito: { tipo: "nenhum", registro: "provedor:PENDING" }, resolve: null });
  });
});

// ── 4. Execução: idempotência e concorrência ─────────────────────────────────

function bancoDeRevisao(inicial: { pedido: any; assinaturas?: any[] }) {
  const estado = {
    revisao: { id: "rev-1", pedidoId: inicial.pedido.id, userId: inicial.pedido.userId, motivo: "confirmacao_divergente", status: "PENDENTE", resolucao: null as string | null, resolvidaEm: null as Date | null },
    pedido: inicial.pedido,
    assinaturas: inicial.assinaturas ?? [] as any[],
    eventos: [] as any[],
  };
  let fila = Promise.resolve();
  let n = 0;
  const chaveDuplicada = () => Object.assign(new Error("P2002"), { code: "P2002", meta: { target: ["chaveIdempotencia"] } });

  const tx: any = {
    $executeRaw: async () => 1,
    revisaoPagamento: {
      findUnique: async () => ({ ...estado.revisao }),
      update: async ({ data }: any) => Object.assign(estado.revisao, data),
      updateMany: async ({ where, data }: any) => {
        if (estado.revisao.status !== where.status) return { count: 0 };
        Object.assign(estado.revisao, data);
        return { count: 1 };
      },
    },
    revisaoPagamentoEvento: {
      create: async ({ data }: any) => {
        if (data.chaveIdempotencia && estado.eventos.some((e) => e.chaveIdempotencia === data.chaveIdempotencia)) throw chaveDuplicada();
        estado.eventos.push(data);
        return data;
      },
    },
    pedidoPagamento: {
      findUnique: async () => ({ ...estado.pedido, assinatura: estado.assinaturas.find((a) => a.pedidoId === estado.pedido.id) ?? null }),
      update: async ({ data }: any) => Object.assign(estado.pedido, data),
      updateMany: async ({ where, data }: any) => {
        if (where.status && estado.pedido.status !== where.status) return { count: 0 };
        Object.assign(estado.pedido, data);
        return { count: 1 };
      },
    },
    assinatura: {
      findMany: async ({ where }: any) => estado.assinaturas.filter((a) =>
        where.id?.in ? where.id.in.includes(a.id) : a.userId === where.userId && a.status === where.status && a.terminaEm > where.terminaEm.gt),
      create: async ({ data }: any) => {
        if (estado.assinaturas.some((a) => a.pedidoId === data.pedidoId)) throw Object.assign(new Error("P2002"), { code: "P2002", meta: { target: ["pedidoId"] } });
        const a = { id: `nova-${++n}`, observacao: null, ...data };
        estado.assinaturas.push(a);
        return a;
      },
      updateMany: async ({ where, data }: any) => {
        const alvo = estado.assinaturas.filter((a) => a.id === where.id && (!where.status || a.status === where.status) && (where.observacao === undefined || a.observacao === where.observacao));
        alvo.forEach((a) => Object.assign(a, data));
        return { count: alvo.length };
      },
    },
  };

  const banco: any = {
    revisaoPagamentoEvento: {
      findUnique: async ({ where }: any) => {
        const e = estado.eventos.find((x) => x.chaveIdempotencia === where.chaveIdempotencia);
        return e ? { revisaoId: e.revisaoId, tipo: e.tipo, codigo: e.codigo } : null;
      },
    },
    revisaoPagamento: {
      findUnique: async () => ({ id: estado.revisao.id, status: estado.revisao.status, pedidoId: estado.pedido.id, pedido: { userId: estado.pedido.userId, transacaoId: estado.pedido.transacaoId } }),
    },
    // Trava por conta + serializável: uma transação por vez.
    $transaction: (fn: any) => {
      const r = fila.then(() => fn(tx));
      fila = r.then(() => undefined, () => undefined);
      return r;
    },
  };
  return { banco, estado };
}

function depsDaAcao(banco: any, status: "PENDING" | "PAID" | "CANCELLED" | "REFUNDED") {
  let consultas = 0;
  const invalidados: string[] = [];
  return {
    consultas: () => consultas,
    invalidados,
    deps: {
      banco,
      agora: () => AGORA,
      invalidar: async (u: string) => { invalidados.push(u); },
      consultar: async () => { consultas++; return { ok: true as const, confirmacao: conf(status) }; },
    },
  };
}

const CHAVE = "chave-da-acao-0001";

describe("executarAcaoDeRevisao", () => {
  test("ativar com PAID: cria uma assinatura, marca PAGO, resolve e registra quem fez", async () => {
    const { banco, estado } = bancoDeRevisao({ pedido: pedidoEm() });
    const d = depsDaAcao(banco, "PAID");
    const r = await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: CHAVE, ator: "admin-1" }, d.deps);
    assert.deepEqual(r, { ok: true, resultado: "ativada", repetida: false, revisaoResolvida: true });
    assert.equal(estado.pedido.status, "PAGO");
    assert.equal(estado.assinaturas.length, 1);
    assert.equal(estado.revisao.status, "RESOLVIDA");
    assert.deepEqual(estado.eventos.map((e) => [e.tipo, e.ator]), [["acao_executada", "admin-1"], ["resolvida", "admin-1"]]);
    assert.deepEqual(d.invalidados, ["u"]);
  });

  test("mesma chave de novo não executa nem consulta o provedor outra vez", async () => {
    const { banco, estado } = bancoDeRevisao({ pedido: pedidoEm() });
    const d = depsDaAcao(banco, "PAID");
    await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: CHAVE, ator: "admin-1" }, d.deps);
    const repetida = await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: CHAVE, ator: "admin-1" }, d.deps);
    assert.equal(repetida.ok && repetida.repetida, true);
    assert.equal(d.consultas(), 1);
    assert.equal(estado.assinaturas.length, 1);
  });

  test("duas ativações simultâneas com chaves diferentes: uma ativa, a outra é recusada", async () => {
    const { banco, estado } = bancoDeRevisao({ pedido: pedidoEm() });
    const d = depsDaAcao(banco, "PAID");
    const [a, b] = await Promise.all([
      executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: "chave-operador-a-01", ator: "admin-a" }, d.deps),
      executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: "chave-operador-b-01", ator: "admin-b" }, d.deps),
    ]);
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    assert.deepEqual([a, b].find((x) => !x.ok), { ok: false, status: 409, codigo: "revisao_ja_resolvida" });
    assert.equal(estado.assinaturas.length, 1);
  });

  test("duas requisições simultâneas com a mesma chave: um efeito só", async () => {
    const { banco, estado } = bancoDeRevisao({ pedido: pedidoEm() });
    const d = depsDaAcao(banco, "PAID");
    const rs = await Promise.all([1, 2].map(() => executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: CHAVE, ator: "admin-1" }, d.deps)));
    assert.equal(estado.assinaturas.length, 1);
    assert.ok(rs.every((r) => r.ok || (r.status === 409)), JSON.stringify(rs));
  });

  test("sem confirmação válida no provedor, nada muda e a recusa fica no histórico", async () => {
    const { banco, estado } = bancoDeRevisao({ pedido: pedidoEm() });
    const d = depsDaAcao(banco, "PENDING");
    const r = await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: CHAVE, ator: "admin-1" }, d.deps);
    assert.deepEqual(r, { ok: false, status: 422, codigo: "pagamento_nao_confirmado" });
    assert.equal(estado.pedido.status, "REVISAO_MANUAL");
    assert.equal(estado.assinaturas.length, 0);
    assert.equal(estado.revisao.status, "PENDENTE");
    assert.deepEqual(estado.eventos.map((e) => [e.tipo, e.codigo]), [["acao_recusada", "ativar:pagamento_nao_confirmado"]]);
  });

  test("provedor sem status: 503, sem efeito, e a classificação real é preservada", async () => {
    const { banco, estado } = bancoDeRevisao({ pedido: pedidoEm() });
    const r = await executarAcaoDeRevisao(
      { revisaoId: "rev-1", acao: "confirmar_estorno", chaveIdempotencia: CHAVE, ator: "admin-1" },
      { banco, agora: () => AGORA, invalidar: async () => {}, consultar: async () => ({ ok: false as const, falha: "timeout" as any }) },
    );
    // Continua 503 (regra financeira intacta), mas o código agora diz QUAL foi a
    // falha em vez do genérico `provedor_indisponivel`.
    assert.deepEqual(r, { ok: false, status: 503, codigo: "provedor_timeout" });
    assert.equal(estado.pedido.status, "REVISAO_MANUAL");
    assert.deepEqual(estado.eventos.map((e) => e.codigo), ["confirmar_estorno:provedor_timeout"]);
  });

  /**
   * O motivo desta fase: antes, toda falha do provedor virava
   * `provedor_indisponivel` e não dava para saber por que a revisão estava
   * presa. Cada classificação passa a ter um código seguro próprio — sem nunca
   * mudar o desfecho financeiro (503, nada muda, revisão continua PENDENTE).
   */
  describe("a classificação da falha do provedor é preservada", () => {
    const casos: [string | null, string][] = [
      [null, "provedor_configuracao"],           // confirmador nem existe (config)
      ["timeout", "provedor_timeout"],
      ["rede", "provedor_rede"],
      ["nao_encontrada", "provedor_nao_encontrado"],
      ["recusada", "provedor_recusado"],
      ["indisponivel", "provedor_indisponivel"],
      ["resposta_invalida", "provedor_resposta_invalida"],
    ];
    for (const [falha, codigo] of casos) {
      test(`${falha ?? "configuracao (confirmador null)"} -> ${codigo}`, async () => {
        const { banco, estado } = bancoDeRevisao({ pedido: pedidoEm() });
        const consultar = falha === null
          ? null
          : (async () => ({ ok: false as const, falha: falha as any }));
        const r = await executarAcaoDeRevisao(
          { revisaoId: "rev-1", acao: "reconsultar", chaveIdempotencia: `chave-diag-${falha ?? "config"}-01`, ator: "admin-1" },
          { banco, agora: () => AGORA, invalidar: async () => {}, consultar },
        );
        assert.deepEqual(r, { ok: false, status: 503, codigo });
        assert.equal(estado.pedido.status, "REVISAO_MANUAL");
        assert.equal(estado.revisao.status, "PENDENTE");
        assert.deepEqual(estado.eventos.map((e) => e.codigo), [`reconsultar:${codigo}`]);
      });
    }
  });

  test("estorno de upgrade: confirmar estorno e recompor, cada um uma vez", async () => {
    const velha = { id: "velha", userId: "u", pedidoId: "anterior", status: "CANCELADA", observacao: OBSERVACAO_DE_SUBSTITUICAO("p"), terminaEm: new Date(AGORA.getTime() + 10 * DIA) };
    const doUpgrade = { id: "do-upgrade", userId: "u", pedidoId: "p", status: "ATIVA", observacao: null, terminaEm: new Date(AGORA.getTime() + 30 * DIA) };
    const { banco, estado } = bancoDeRevisao({ pedido: pedidoEm({ status: "PAGO", operacao: "upgrade", assinaturasSubstituidas: ["velha"] }), assinaturas: [velha, doUpgrade] });
    const d = depsDaAcao(banco, "REFUNDED");

    const estorno = await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "confirmar_estorno", chaveIdempotencia: "estorno-chave-0001", ator: "admin-1" }, d.deps);
    assert.deepEqual(estorno, { ok: true, resultado: "confirmar_estorno", repetida: false, revisaoResolvida: false });
    assert.equal(estado.pedido.status, "ESTORNADO");
    assert.equal(doUpgrade.status, "CANCELADA");
    assert.equal(velha.status, "CANCELADA", "estorno não restaura sozinho");
    assert.equal(estado.revisao.motivo, "estorno_upgrade");

    const recompor = await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "recompor_upgrade", chaveIdempotencia: "recompor-chave-001", ator: "admin-1" }, d.deps);
    assert.deepEqual(recompor, { ok: true, resultado: "upgrade_recomposto", repetida: false, revisaoResolvida: true });
    assert.equal(velha.status, "ATIVA");

    const deNovo = await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "recompor_upgrade", chaveIdempotencia: "recompor-chave-002", ator: "admin-1" }, d.deps);
    assert.deepEqual(deNovo, { ok: false, status: 409, codigo: "revisao_ja_resolvida" });
    assert.equal(estado.assinaturas.filter((a) => a.status === "ATIVA").length, 1);
  });

  test("entradas inválidas são recusadas antes de qualquer consulta", async () => {
    const { banco } = bancoDeRevisao({ pedido: pedidoEm() });
    const d = depsDaAcao(banco, "PAID");
    assert.deepEqual(await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "apagar", chaveIdempotencia: CHAVE, ator: "a" }, d.deps), { ok: false, status: 400, codigo: "acao_invalida" });
    assert.deepEqual(await executarAcaoDeRevisao({ revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: "curta", ator: "a" }, d.deps), { ok: false, status: 400, codigo: "chave_invalida" });
    assert.equal(d.consultas(), 0);
  });
});

// ── 5. Rotas: comprador e operação ───────────────────────────────────────────

const req = new NextRequest("http://local");

describe("comprador vê o pagamento em análise", () => {
  const prismaComCaso = {
    revisaoPagamento: { findFirst: async () => ({ pedido: { id: "p", status: "REVISAO_MANUAL", valorCentavos: 1990, moeda: "BRL", expiraEm: null } }) },
    pedidoPagamento: { findFirst: async () => assert.fail("com revisão pendente, não procura PIX aguardando") },
  };

  test("depois de recarregar, sair e entrar: o mesmo caso aparece com a mensagem", async () => {
    for (let sessao = 0; sessao < 2; sessao++) {
      const h = pendingGet.createForTest({ getUserFromRequest: async () => ({ userId: "u" }), prisma: prismaComCaso });
      const body = await (await h(req)).json();
      assert.equal(body.pedido.pedidoId, "p");
      assert.equal(body.pedido.emRevisao, true);
      assert.equal(body.pedido.mensagem, MENSAGEM_DE_REVISAO_AO_COMPRADOR);
      assert.equal(JSON.stringify(body).match(/transac|pix|prazo|notific/i), null);
    }
  });

  test("status do pedido informa a revisão", async () => {
    const h = pedidoGet.createForTest({
      getUserFromRequest: async () => ({ userId: "u" }), confirmacaoAtiva: () => false,
      prisma: {
        pedidoPagamento: { findFirst: async () => ({ id: "p", status: "REVISAO_MANUAL", valorCentavos: 1990, moeda: "BRL", expiraEm: null, transacaoId: "tx" }), findUnique: async () => ({ id: "p", status: "REVISAO_MANUAL", valorCentavos: 1990, moeda: "BRL", expiraEm: null }) },
        revisaoPagamento: { findFirst: async () => ({ id: "rev-1" }) },
      },
    });
    const body = await (await h(req, { params: { id: "p" } })).json();
    assert.equal(body.emRevisao, true);
    assert.equal(body.mensagem, MENSAGEM_DE_REVISAO_AO_COMPRADOR);
  });

  test("mensagem exata, sem prazo nem notificação prometidos", () => {
    assert.equal(MENSAGEM_DE_REVISAO_AO_COMPRADOR, "Seu pagamento está em análise. Não faça outro pagamento para esta assinatura. Acompanhe o status por aqui.");
    assert.equal(mensagemErroCheckout("pagamento_em_revisao"), MENSAGEM_DE_REVISAO_AO_COMPRADOR);
  });
});

describe("rotas administrativas", () => {
  const negar = async () => new Response(JSON.stringify({ error: "Não autorizado" }), { status: 403 }) as any;

  test("consulta exige admin e devolve motivo, valores, tempo e transação mascarada", async () => {
    assert.equal((await listarRevisoesGet.createForTest({ requireAdmin: negar })(req)).status, 403);

    const h = listarRevisoesGet.createForTest({
      requireAdmin: async () => null,
      agora: () => AGORA,
      prisma: {
        revisaoPagamento: {
          findMany: async (q: any) => {
            assert.equal(q.where.status, "PENDENTE");
            assert.equal(q.take, 50);
            return [{
              id: "rev-1", userId: "u", motivo: "estorno_upgrade", status: "PENDENTE", resolucao: null,
              abertaEm: new Date(AGORA.getTime() - 90 * 60_000), resolvidaEm: null,
              pedido: { id: "p", status: "ESTORNADO", operacao: "upgrade", valorCentavos: 18457, valorPlanoCentavos: 18990, valorAdicionaisCentavos: 0, creditoCentavos: 533, moeda: "BRL", transacaoId: "TX-1234567890", criadoEm: AGORA, expiraEm: null },
              eventos: [{ tipo: "aberta", codigo: "estorno_upgrade", ator: "sistema", observacao: null, criadoEm: AGORA }],
            }];
          },
        },
      },
    });
    const body = await (await h(new NextRequest("http://local/api/admin/pagamentos/revisoes"))).json();
    const caso = body.casos[0];
    assert.equal(caso.tempoEmRevisaoSegundos, 5400);
    assert.equal(caso.motivoDescricao.length > 0, true);
    assert.equal(caso.pedido.transacao, "****7890");
    assert.equal(caso.pedido.creditoCentavos, 533);
    assert.equal(JSON.stringify(body).includes("TX-1234567890"), false);
  });

  test("ação exige admin, confere origem de navegador e registra o ator autenticado", async () => {
    const corpo = JSON.stringify({ acao: "ativar", chaveIdempotencia: CHAVE, ator: "forjado" });
    const post = (headers: Record<string, string>) => new NextRequest("http://local/api/admin/pagamentos/revisoes/rev-1", { method: "POST", headers: { "content-type": "application/json", host: "local", ...headers }, body: corpo });

    assert.equal((await acaoRevisaoPost.createForTest({ requireAdmin: negar })(post({}), { params: { id: "rev-1" } })).status, 403);

    let recebido: any;
    const executar = async (e: any) => { recebido = e; return { ok: true, resultado: "ativada", repetida: false, revisaoResolvida: true }; };

    const outraOrigem = acaoRevisaoPost.createForTest({ requireAdmin: async () => null, executarAcaoDeRevisao: executar, getServerSession: async () => ({ user: { id: "admin-1" } }) });
    assert.equal((await outraOrigem(post({ origin: "https://atacante.invalid" }), { params: { id: "rev-1" } })).status, 403);

    const porSessao = acaoRevisaoPost.createForTest({ requireAdmin: async () => null, executarAcaoDeRevisao: executar, getServerSession: async () => ({ user: { id: "admin-1" } }) });
    assert.equal((await porSessao(post({ origin: "http://local" }), { params: { id: "rev-1" } })).status, 200);
    assert.equal(recebido.ator, "admin-1", "ator vem da sessão, nunca do corpo");
    assert.equal(recebido.revisaoId, "rev-1");

    const porToken = acaoRevisaoPost.createForTest({ requireAdmin: async () => null, executarAcaoDeRevisao: executar });
    await porToken(post({ "x-admin-token": "x".repeat(40) }), { params: { id: "rev-1" } });
    assert.equal(recebido.ator, "token_admin");

    const recusada = acaoRevisaoPost.createForTest({ requireAdmin: async () => null, executarAcaoDeRevisao: async () => ({ ok: false, status: 422, codigo: "pagamento_nao_confirmado" }), getServerSession: async () => ({ user: { id: "admin-1" } }) });
    const r = await recusada(post({}), { params: { id: "rev-1" } });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).codigo, "pagamento_nao_confirmado");
  });
});
