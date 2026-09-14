import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  BYTES_DA_REF_EXTERNA,
  CAMPOS_FINANCEIROS_PROIBIDOS,
  STATUS_DA_FASE_4,
  campoFinanceiroNoCorpo,
  cobrancaPixAtiva,
  criarPedidoPix,
  gerarRefExterna,
  resolverPreco,
  type DadosDoPagador,
  type FalhaDoProvedor,
  type NovoPedido,
  type PedidoParaProvedor,
  type PrecoDoBanco,
  type ProvedorPix,
  type RepositorioDePedidos,
  type VendaPixCriada,
} from "../billing/pedidos";

/**
 * O serviço de criação de PIX, exercitado inteiro sem rede e sem banco.
 *
 * As duas promessas que estes testes existem para tornar impossíveis de quebrar
 * em silêncio:
 *
 *   1. **o preço nunca vem do cliente** — sai do banco, e o que é enviado ao
 *      provedor é o snapshot;
 *   2. **nada aqui ativa assinatura** — nenhum caminho escreve `PAGO`, nenhum
 *      toca `Assinatura`, nenhum invalida entitlements.
 *
 * O repositório falso registra *cada* gravação, e o provedor falso registra
 * *cada* chamada. É o que permite afirmar não só o resultado, mas o que
 * **deixou** de acontecer — que é a parte cara de garantir numa camada de
 * pagamento.
 */

// ── Dublês ───────────────────────────────────────────────────────────────────

interface Gravacao {
  op: "criar" | "registrarVenda" | "registrarFalha";
  pedidoId: string;
  status?: string;
  transacaoId?: string;
  expiraEm?: Date;
  dados?: NovoPedido;
}

function repositorioFalso(preco: PrecoDoBanco | null) {
  const gravacoes: Gravacao[] = [];
  let n = 0;

  const repo: RepositorioDePedidos = {
    async buscarPreco() {
      return preco;
    },
    async buscarAdicionais() {
      return { telaMensalCentavos: null, servidorVipMensalCentavos: null };
    },
    async periodosEmAberto() {
      return [];
    },
    async criar(dados) {
      const id = `pedido_${++n}`;
      gravacoes.push({ op: "criar", pedidoId: id, status: dados.status, dados });
      return { id };
    },
    async registrarVenda(pedidoId, d) {
      gravacoes.push({ op: "registrarVenda", pedidoId, status: "AGUARDANDO", ...d });
    },
    async registrarFalha(pedidoId, d) {
      gravacoes.push({ op: "registrarFalha", pedidoId, ...d });
    },
  };

  return {
    repo,
    gravacoes,
    /** Todo status que chegou a ser escrito, na ordem. */
    statusEscritos: () => gravacoes.map((g) => g.status).filter(Boolean) as string[],
  };
}

const VENDA_OK: VendaPixCriada = {
  transacaoId: "TXN-DUBLE-1",
  valorCentavos: 1890,
  expiraEm: new Date("2026-09-12T10:30:00.000Z"),
  qrCode: "00020126580014br.gov.bcb.pix-qr",
  copiaECola: "00020126580014br.gov.bcb.pix-copia",
  qrCodeBase64: "data:image/png;base64,AAAA",
};

function provedorFalso(
  resposta:
    | { ok: true; venda: VendaPixCriada }
    | { ok: false; falha: FalhaDoProvedor; transacaoId?: string },
) {
  const chamadas: PedidoParaProvedor[] = [];
  const provedor: ProvedorPix = {
    async criarVenda(pedido) {
      chamadas.push(pedido);
      return resposta;
    },
  };
  return { provedor, chamadas };
}

const PRECO: PrecoDoBanco = {
  id: "preco_plus_mensal",
  planoId: "plus",
  rotulo: "Mensal",
  precoCentavos: 1890,
  duracaoDias: 30,
  moeda: "BRL",
  ativo: true,
  plano: { id: "plus", nome: "Plus", ativo: true },
};

const PAGADOR: DadosDoPagador = {
  nome: "Fulano de Tal",
  email: "fulano@example.test",
  telefone: "11999999999",
  documento: { numero: "12345678901", tipo: "cpf" },
};

const ENTRADA = {
  userId: "user_1",
  planoId: "plus",
  planoPrecoId: "preco_plus_mensal",
  pagador: PAGADOR,
};

// ── Flag ─────────────────────────────────────────────────────────────────────

describe("BLACKCAT_PIX_ATIVO: só a string exata liga", () => {
  test('"true" liga', () => {
    assert.equal(cobrancaPixAtiva({ BLACKCAT_PIX_ATIVO: "true" }), true);
  });

  /**
   * `Boolean(process.env.BLACKCAT_PIX_ATIVO)` é o erro clássico: `Boolean("false")`
   * é `true`, então escrever `BLACKCAT_PIX_ATIVO=false` para **desligar** a
   * cobrança a **ligaria**. A comparação estrita não tem esse modo de falha.
   */
  test("todo o resto deixa desligado", () => {
    for (const valor of ["false", "TRUE", "True", "1", "0", "sim", " true", "true ", ""]) {
      assert.equal(
        cobrancaPixAtiva({ BLACKCAT_PIX_ATIVO: valor }),
        false,
        `"${valor}" não pode ligar a cobrança`,
      );
    }
    assert.equal(cobrancaPixAtiva({}), false);
  });

  /** Interruptores diferentes, de coisas diferentes. */
  test("MONETIZACAO_ATIVA não liga a cobrança", () => {
    assert.equal(cobrancaPixAtiva({ MONETIZACAO_ATIVA: "true" }), false);
  });

  test("não existe variável NEXT_PUBLIC_ equivalente", () => {
    assert.equal(cobrancaPixAtiva({ NEXT_PUBLIC_BLACKCAT_PIX_ATIVO: "true" }), false);
  });
});

// ── refExterna ───────────────────────────────────────────────────────────────

describe("refExterna", () => {
  test("tem 128 bits de aleatoriedade", () => {
    assert.equal(BYTES_DA_REF_EXTERNA, 16);
    assert.equal(gerarRefExterna().length, BYTES_DA_REF_EXTERNA * 2);
    assert.match(gerarRefExterna(), /^[0-9a-f]+$/);
  });

  test("não repete", () => {
    const vistas = new Set(Array.from({ length: 500 }, () => gerarRefExterna()));
    assert.equal(vistas.size, 500);
  });

  /**
   * A referência sai **inteira** da fonte de aleatoriedade, e de mais nada.
   *
   * Procurar `userId` ou timestamp dentro do resultado não provaria isto: num
   * texto hexadecimal de 32 caracteres, quase qualquer sequência curta aparece
   * por acaso. Fixar a fonte e comparar a saída byte a byte prova o que importa
   * — nenhum pedaço previsível é concatenado, e nenhum byte aleatório é
   * descartado. Um identificador previsível aqui permitiria enumerar pedidos de
   * outras contas, e `refExterna` viaja para fora, no `externalRef` da Blackcat.
   */
  test("deriva só da fonte de aleatoriedade, e usa todos os bytes", () => {
    const bytes = Buffer.from([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
      0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    ]);

    let pedidos = 0;
    const ref = gerarRefExterna((n) => {
      pedidos = n;
      return bytes;
    });

    assert.equal(pedidos, BYTES_DA_REF_EXTERNA, "precisa pedir 128 bits");
    assert.equal(ref, "00112233445566778899aabbccddeeff");
  });
});

// ── Fronteira de confiança ───────────────────────────────────────────────────

describe("o cliente não fala de dinheiro", () => {
  test("os campos financeiros conhecidos são detectados", () => {
    for (const campo of CAMPOS_FINANCEIROS_PROIBIDOS) {
      assert.equal(campoFinanceiroNoCorpo({ [campo]: 1 }), campo);
    }
  });

  /** Mandar `{"amount": null}` também é o cliente tentando falar de dinheiro. */
  test("o campo presente com valor nulo também é recusado", () => {
    assert.equal(campoFinanceiroNoCorpo({ amount: null }), "amount");
    assert.equal(campoFinanceiroNoCorpo({ amount: undefined }), "amount");
  });

  test("um corpo legítimo passa", () => {
    assert.equal(
      campoFinanceiroNoCorpo({ planoId: "plus", planoPrecoId: "p1", documento: "1", telefone: "2" }),
      null,
    );
  });

  test("a lista cobre os nomes que a Blackcat e o nosso banco usam", () => {
    for (const esperado of ["amount", "valorCentavos", "precoCentavos", "duracaoDias", "status", "transactionId", "externalRef"]) {
      assert.ok(
        (CAMPOS_FINANCEIROS_PROIBIDOS as readonly string[]).includes(esperado),
        `${esperado} precisa estar na lista`,
      );
    }
  });
});

// ── Resolução de preço ───────────────────────────────────────────────────────

describe("resolverPreco: nenhuma ramificação por nome de plano", () => {
  test("preço válido gera snapshot com os valores do banco", () => {
    const r = resolverPreco(PRECO, "plus");
    assert.equal(r.compravel, true);
    assert.deepEqual(r.compravel && r.snapshot, {
      planoId: "plus",
      planoPrecoId: "preco_plus_mensal",
      valorCentavos: 1890,
      moeda: "BRL",
      duracaoDias: 30,
      duracaoMeses: null,
      descricao: "Plus — Mensal",
    });
  });

  const recusas: [string, PrecoDoBanco | null, string][] = [
    ["preco_inexistente", null, "plus"],
    ["preco_inativo", { ...PRECO, ativo: false }, "plus"],
    ["plano_ausente", { ...PRECO, plano: null }, "plus"],
    ["plano_inativo", { ...PRECO, plano: { ...PRECO.plano!, ativo: false } }, "plus"],
    ["plano_divergente", PRECO, "premium"],
    ["valor_invalido", { ...PRECO, precoCentavos: 0 }, "plus"],
    ["valor_invalido", { ...PRECO, precoCentavos: -100 }, "plus"],
    ["valor_invalido", { ...PRECO, precoCentavos: 18.9 }, "plus"],
    ["duracao_invalida", { ...PRECO, duracaoDias: 0 }, "plus"],
    ["moeda_nao_suportada", { ...PRECO, moeda: "USD" }, "plus"],
  ];

  for (const [motivo, preco, planoId] of recusas) {
    test(`recusa: ${motivo}${preco === PRECO && planoId !== "plus" ? " (par incoerente)" : ""}`, () => {
      const r = resolverPreco(preco, planoId);
      assert.equal(r.compravel, false);
      assert.equal(r.compravel === false && r.motivo, motivo);
    });
  }

  /**
   * O nome comercial não decide nada. Um plano chamado "Gratuito" com preço
   * ativo e positivo é comprável; um chamado "Premium" com preço inativo não é.
   */
  test("o nome do plano não concede nem nega", () => {
    const gratuitoPago = { ...PRECO, plano: { id: "plus", nome: "Gratuito", ativo: true } };
    assert.equal(resolverPreco(gratuitoPago, "plus").compravel, true);

    const premiumInativo = { ...PRECO, ativo: false, plano: { id: "plus", nome: "Premium", ativo: true } };
    assert.equal(resolverPreco(premiumInativo, "plus").compravel, false);
  });
});

// ── O serviço ────────────────────────────────────────────────────────────────

describe("criarPedidoPix: o valor vem do banco, nunca do cliente", () => {
  /**
   * O teste central da fase.
   *
   * A entrada declara `planoId` e `planoPrecoId` e mais nada; o que chega ao
   * provedor é `precoCentavos` do banco. Se algum dia alguém acrescentar um
   * campo de valor à entrada e o encaminhar, isto quebra.
   */
  test("o valor enviado ao provedor é o do PlanoPreco", async () => {
    const { repo } = repositorioFalso(PRECO);
    const { provedor, chamadas } = provedorFalso({ ok: true, venda: VENDA_OK });

    await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].valorCentavos, 1890);
    assert.equal(chamadas[0].moeda, "BRL");
  });

  test("um valor injetado na entrada não altera a cobrança", async () => {
    const { repo, gravacoes } = repositorioFalso(PRECO);
    const { provedor, chamadas } = provedorFalso({ ok: true, venda: VENDA_OK });

    // O tipo de `EntradaDoPedido` não tem estes campos; o `as` reproduz o que
    // aconteceria se um objeto vindo de JSON chegasse com eles.
    const entradaMaliciosa = {
      ...ENTRADA,
      valorCentavos: 1,
      amount: 1,
      precoCentavos: 1,
      duracaoDias: 3650,
      moeda: "USD",
    } as unknown as typeof ENTRADA;

    const r = await criarPedidoPix(entradaMaliciosa, { repo, provedor });

    assert.equal(chamadas[0].valorCentavos, 1890);
    assert.equal(chamadas[0].moeda, "BRL");
    assert.equal(r.situacao === "criado" && r.valorCentavos, 1890);
    assert.equal(gravacoes[0].dados?.valorCentavos, 1890);
    assert.equal(gravacoes[0].dados?.duracaoDias, 30);
    assert.equal(gravacoes[0].dados?.moeda, "BRL");
  });

  test("duracaoDias gravada é o snapshot do banco", async () => {
    const { repo, gravacoes } = repositorioFalso({ ...PRECO, duracaoDias: 180 });
    const { provedor } = provedorFalso({ ok: true, venda: VENDA_OK });

    await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.equal(gravacoes[0].dados?.duracaoDias, 180);
  });
});

describe("criarPedidoPix: preço não comprável não chega ao provedor", () => {
  const casos: [string, PrecoDoBanco | null, string][] = [
    ["preço inexistente", null, "plus"],
    ["preço inativo", { ...PRECO, ativo: false }, "plus"],
    ["plano inativo", { ...PRECO, plano: { ...PRECO.plano!, ativo: false } }, "plus"],
    ["plano e preço incompatíveis", PRECO, "premium"],
    ["preço zero", { ...PRECO, precoCentavos: 0 }, "plus"],
  ];

  for (const [nome, preco, planoId] of casos) {
    /**
     * Recusar antes do provedor não é otimização: um pedido negado não pode
     * custar uma requisição externa nem deixar linha no banco.
     */
    test(`${nome}: nenhuma chamada, nenhuma gravação`, async () => {
      const { repo, gravacoes } = repositorioFalso(preco);
      const { provedor, chamadas } = provedorFalso({ ok: true, venda: VENDA_OK });

      const r = await criarPedidoPix({ ...ENTRADA, planoId }, { repo, provedor });

      assert.equal(r.situacao, "nao_compravel");
      assert.equal(chamadas.length, 0, "o provedor não pode ser chamado");
      assert.equal(gravacoes.length, 0, "nenhum pedido pode ser criado");
    });
  }
});

describe("criarPedidoPix: caminho feliz", () => {
  test("CRIADO antes da chamada, AGUARDANDO depois", async () => {
    const { repo, gravacoes, statusEscritos } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: true, venda: VENDA_OK });

    const r = await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.equal(r.situacao, "criado");
    assert.deepEqual(statusEscritos(), ["CRIADO", "AGUARDANDO"]);
    assert.equal(gravacoes[0].op, "criar");
    assert.equal(gravacoes[1].op, "registrarVenda");
  });

  /**
   * O pedido local precisa existir ANTES da chamada externa: se a venda for
   * criada lá e nós nunca soubermos, ainda assim existe do nosso lado uma linha
   * com a `refExterna` que aquela venda carrega.
   */
  test("a refExterna gravada é a mesma enviada ao provedor", async () => {
    const { repo, gravacoes } = repositorioFalso(PRECO);
    const { provedor, chamadas } = provedorFalso({ ok: true, venda: VENDA_OK });

    await criarPedidoPix(ENTRADA, { repo, provedor, gerarRef: () => "ref-fixa-para-teste" });

    assert.equal(gravacoes[0].dados?.refExterna, "ref-fixa-para-teste");
    assert.equal(chamadas[0].refExterna, "ref-fixa-para-teste");
  });

  test("transactionId e expiraEm são persistidos", async () => {
    const { repo, gravacoes } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: true, venda: VENDA_OK });

    await criarPedidoPix(ENTRADA, { repo, provedor });

    const venda = gravacoes.find((g) => g.op === "registrarVenda");
    assert.equal(venda?.transacaoId, "TXN-DUBLE-1");
    assert.deepEqual(venda?.expiraEm, VENDA_OK.expiraEm);
  });

  test("o PIX volta para quem pediu, e o pedido nasce com provedor blackcat", async () => {
    const { repo, gravacoes } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: true, venda: VENDA_OK });

    const r = await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.equal(r.situacao === "criado" && r.status, "AGUARDANDO");
    assert.equal(r.situacao === "criado" && r.pix.qrCode, VENDA_OK.qrCode);
    assert.equal(r.situacao === "criado" && r.pix.copiaECola, VENDA_OK.copiaECola);
    assert.equal(gravacoes[0].dados?.provedor, "blackcat");
  });
});

describe("criarPedidoPix: valor divergente não vira sucesso", () => {
  const divergente = { ...VENDA_OK, valorCentavos: 100 };

  test("não devolve PIX, e o pedido vai para REVISAO_MANUAL", async () => {
    const { repo, statusEscritos } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: true, venda: divergente });

    const r = await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.equal(r.situacao, "revisao_manual");
    assert.deepEqual(statusEscritos(), ["CRIADO", "REVISAO_MANUAL"]);
    assert.equal("pix" in r, false, "não pode entregar o QR como se estivesse tudo certo");
  });

  /**
   * REVISAO_MANUAL e não FALHOU porque a venda **existe** lá e é pagável.
   * `FALHOU` diria "não há nada" e faria a reconciliação da Fase 5 ignorar
   * justamente a linha que precisa de gente olhando. O `transacaoId` é gravado
   * para o cruzamento ser possível — e não é concessão de nada.
   */
  test("guarda o transacaoId, para a revisão ter como cruzar", async () => {
    const { repo, gravacoes } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: true, venda: divergente });

    const r = await criarPedidoPix(ENTRADA, { repo, provedor });

    const falha = gravacoes.find((g) => g.op === "registrarFalha");
    assert.equal(falha?.status, "REVISAO_MANUAL");
    assert.equal(falha?.transacaoId, "TXN-DUBLE-1");
    assert.equal(r.situacao === "revisao_manual" && r.motivo, "valor_divergente");
  });

  test("valor a MAIOR também é divergência", async () => {
    const { repo } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: true, venda: { ...VENDA_OK, valorCentavos: 999999 } });

    const r = await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.equal(r.situacao, "revisao_manual");
  });
});

describe("criarPedidoPix: falhas do provedor viram estado controlado", () => {
  const falhas: FalhaDoProvedor[] = [
    "timeout",
    "rede",
    "recusado",
    "indisponivel",
    "resposta_invalida",
    "configuracao",
  ];

  for (const falha of falhas) {
    test(`${falha}: pedido em FALHOU, sem PIX`, async () => {
      const { repo, statusEscritos } = repositorioFalso(PRECO);
      const { provedor } = provedorFalso({ ok: false, falha });

      const r = await criarPedidoPix(ENTRADA, { repo, provedor });

      assert.equal(r.situacao, "falha_no_provedor");
      assert.equal(r.situacao === "falha_no_provedor" && r.falha, falha);
      assert.deepEqual(statusEscritos(), ["CRIADO", "FALHOU"]);
    });
  }

  /**
   * `resposta_invalida` é o que cobre "sem transactionId" e "PIX incompleto": o
   * provedor classifica a forma da resposta e o serviço nunca vê um payload
   * meio-válido. Os testes de `interpretarVenda` em `billingBlackcat.test.ts`
   * exercitam cada campo faltando.
   */
  test("falha não devolve dado de PIX nenhum", async () => {
    const { repo } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: false, falha: "resposta_invalida" });

    const r = await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.equal("pix" in r, false);
    assert.equal("expiraEm" in r, false);
  });
});

/**
 * A regra única do serviço diante de uma falha do provedor:
 *
 *   **transação conhecida ⇒ `REVISAO_MANUAL`. Transação desconhecida ⇒ `FALHOU`.**
 *
 * O motivo é o mesmo que já valia para o valor divergente: se sabemos o
 * `transactionId`, existe uma venda do outro lado que pode ser pagável, e
 * `FALHOU` faria a reconciliação da Fase 5 pular exatamente a linha que precisa
 * de gente olhando. `FALHOU` fica reservado para "não há nada lá para procurar".
 */
describe("falha com transação conhecida vira REVISAO_MANUAL", () => {
  const comTransacao: FalhaDoProvedor[] = [
    "estado_externo_inesperado",
    "resposta_incompleta",
  ];

  for (const falha of comTransacao) {
    test(`${falha}: REVISAO_MANUAL com o transacaoId gravado`, async () => {
      const { repo, gravacoes, statusEscritos } = repositorioFalso(PRECO);
      const { provedor } = provedorFalso({ ok: false, falha, transacaoId: "TXN-EXTERNA-9" });

      const r = await criarPedidoPix(ENTRADA, { repo, provedor });

      assert.equal(r.situacao, "revisao_manual");
      assert.equal(r.situacao === "revisao_manual" && r.motivo, falha);
      assert.deepEqual(statusEscritos(), ["CRIADO", "REVISAO_MANUAL"]);

      const registro = gravacoes.find((g) => g.op === "registrarFalha");
      assert.equal(registro?.transacaoId, "TXN-EXTERNA-9");
      assert.equal("pix" in r, false, "não devolve PIX");
    });
  }

  test("a mesma falha SEM transação vira FALHOU, e não grava transacaoId", async () => {
    const { repo, gravacoes, statusEscritos } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: false, falha: "estado_externo_inesperado" });

    const r = await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.equal(r.situacao, "falha_no_provedor");
    assert.deepEqual(statusEscritos(), ["CRIADO", "FALHOU"]);
    assert.equal(gravacoes.find((g) => g.op === "registrarFalha")?.transacaoId, undefined);
  });

  /**
   * O caso que a Fase 4 existe para não errar: um `PAID` na resposta de criação
   * chega aqui como `estado_externo_inesperado`, e o pedido vai para revisão —
   * **nunca** para `PAGO`, e nunca devolve PIX como sucesso.
   */
  test('um "PAID" na criação não vira PAGO nem sucesso', async () => {
    const { repo, statusEscritos } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({
      ok: false,
      falha: "estado_externo_inesperado",
      transacaoId: "TXN-PAID-NA-CRIACAO",
    });

    const r = await criarPedidoPix(ENTRADA, { repo, provedor });

    assert.notEqual(r.situacao, "criado");
    for (const status of statusEscritos()) {
      assert.notEqual(status, "PAGO");
    }
  });
});

/**
 * A seção que dá nome à fase.
 *
 * Percorre **todos** os desfechos de `criarPedidoPix` e verifica o que não
 * aconteceu em nenhum deles. Um `PAGO` acrescentado por engano em qualquer ramo
 * futuro quebra aqui.
 */
describe("NENHUM caminho ativa assinatura", () => {
  const cenarios: [string, PrecoDoBanco | null, Parameters<typeof provedorFalso>[0]][] = [
    ["sucesso", PRECO, { ok: true, venda: VENDA_OK }],
    ["valor divergente", PRECO, { ok: true, venda: { ...VENDA_OK, valorCentavos: 1 } }],
    ["timeout", PRECO, { ok: false, falha: "timeout" }],
    ["estado externo inesperado (PAID na criacao)", PRECO, { ok: false, falha: "estado_externo_inesperado", transacaoId: "TXN-X" }],
    ["recusado", PRECO, { ok: false, falha: "recusado" }],
    ["preço inexistente", null, { ok: true, venda: VENDA_OK }],
    ["preço inativo", { ...PRECO, ativo: false }, { ok: true, venda: VENDA_OK }],
  ];

  for (const [nome, preco, resposta] of cenarios) {
    test(`${nome}: nunca escreve PAGO`, async () => {
      const { repo, statusEscritos } = repositorioFalso(preco);
      const { provedor } = provedorFalso(resposta);

      await criarPedidoPix(ENTRADA, { repo, provedor });

      for (const status of statusEscritos()) {
        assert.notEqual(status, "PAGO", "esta fase não confirma pagamento");
        assert.ok(
          (STATUS_DA_FASE_4 as readonly string[]).includes(status),
          `${status} está fora dos estados que a Fase 4 pode escrever`,
        );
      }
    });
  }

  /**
   * O repositório falso implementa **apenas** as três operações da porta. Se o
   * serviço tentasse criar assinatura ou invalidar entitlements, precisaria de
   * um método que não existe — e o teste falharia com TypeError em vez de passar
   * em silêncio.
   */
  test("a porta do banco não tem como criar assinatura", async () => {
    const { repo, gravacoes } = repositorioFalso(PRECO);
    const { provedor } = provedorFalso({ ok: true, venda: VENDA_OK });

    await criarPedidoPix(ENTRADA, { repo, provedor });

    for (const g of gravacoes) {
      assert.ok(["criar", "registrarVenda", "registrarFalha"].includes(g.op));
    }
    // 6 métodos: os 4 de escrita do pedido e 2 leituras (adicionais e períodos
    // em aberto, para calcular operação e crédito). Nenhum escreve assinatura.
    assert.equal(Object.keys(repo).length, 6, "a porta tem 6 métodos, e nenhum escreve assinatura");
  });

  /**
   * `invalidarEntitlements` derruba o cache de direitos, e só faz sentido quando
   * um direito muda. Chamá-la aqui seria sinal de que alguém passou a achar que
   * criar pedido muda direito — que é exatamente o erro que esta fase evita.
   */
  test("o módulo não alcança entitlements, Assinatura nem o Prisma", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fonte = readFileSync(join(process.cwd(), "src/lib/billing/pedidos.ts"), "utf8");
    const codigo = fonte
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

    for (const proibido of [
      "invalidarEntitlements",
      "entitlementsDoUsuario",
      "prisma",
    ]) {
      assert.equal(
        codigo.includes(proibido),
        false,
        `${proibido} não pode aparecer no código do serviço de pedidos`,
      );
    }
    // `assinaturasSubstituidas` é só um snapshot de ids no pedido; o que não pode
    // existir é acesso ao modelo `assinatura`.
    assert.equal(/\bassinatura\b/i.test(codigo), false, "assinatura não pode aparecer no código do serviço de pedidos");

    // `PAGO` aparece uma vez, e só uma: dentro de `STATUS_PEDIDO`, porque o
    // CHECK do banco precisa do estado declarado. O que não pode existir é uma
    // ATRIBUIÇÃO dele — é isso que separa "o estado existe no domínio" de "esta
    // fase confirma pagamento".
    assert.equal(
      /status:\s*["']PAGO["']/.test(codigo),
      false,
      "nenhum caminho desta fase pode atribuir PAGO",
    );
    assert.equal(
      (STATUS_DA_FASE_4 as readonly string[]).includes("PAGO"),
      false,
      "PAGO não é um estado que a Fase 4 escreve",
    );
  });
});
