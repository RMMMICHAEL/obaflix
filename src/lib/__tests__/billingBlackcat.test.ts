import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  BASE_BLACKCAT_PADRAO,
  classificarStatus,
  interpretarVenda,
  STATUS_DE_CRIACAO_ACEITO,
  lerConfiguracao,
  provedorComConfiguracao,
  criarConfirmadorBlackcat,
  interpretarConfirmacao,
} from "../billing/blackcat";
import type { PedidoParaProvedor } from "../billing/pedidos";

/**
 * O provedor Blackcat, exercitado sem tocar na rede.
 *
 * **Nenhum teste aqui fala com a Blackcat de verdade.** O `fetch` é injetado, e
 * é ele que devolve as respostas — inclusive as malformadas, que são as que
 * importam: uma resposta que passa pela validação sem ter o que promete é o que
 * transformaria "criamos um PIX" numa afirmação falsa.
 *
 * A chave usada em todos os casos é literal e sem valor nenhum. Nenhuma
 * credencial real aparece neste arquivo.
 */

const CONFIG = { apiKey: "chave-de-teste-sem-valor", baseUrl: BASE_BLACKCAT_PADRAO };

const PEDIDO: PedidoParaProvedor = {
  refExterna: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  valorCentavos: 1890,
  moeda: "BRL",
  descricao: "Plus — Mensal",
  pagador: {
    nome: "Fulano de Tal",
    email: "fulano@example.test",
    telefone: "11999999999",
    documento: { numero: "12345678901", tipo: "cpf" },
  },
};

const respostaStatus = (data: Record<string, unknown>) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

describe("confirmação autoritativa", () => {
  test("GET codifica a transação, usa chave e no-store", async () => {
    let url = ""; let init: RequestInit | undefined;
    const confirmar = criarConfirmadorBlackcat({ BLACKCAT_API_KEY: "teste" }, async (u, i) => { url=String(u); init=i; return respostaStatus({transactionId:"a/b",status:"PAID",amount:100}); });
    const r=await confirmar!("a/b"); assert.equal(r.ok,true); assert.match(url,/a%2Fb\/status$/); assert.equal((init?.headers as Record<string,string>)["X-API-Key"],"teste"); assert.equal(init?.cache,"no-store"); assert.ok(init?.signal);
  });
  for (const status of ["PENDING","PAID","CANCELLED","REFUNDED"] as const) test(`${status} é aceito`,()=>assert.equal(interpretarConfirmacao({success:true,data:{transactionId:"t",status,amount:100}})?.status,status));
  test("success falso e formatos inválidos são recusados",()=>{
    for(const body of [{success:false,data:{transactionId:"t",status:"PAID",amount:1}},{success:true},{success:true,data:{status:"PAID",amount:1}},{success:true,data:{transactionId:"t",status:"X",amount:1}},{success:true,data:{transactionId:"t",status:"PAID",amount:"1"}},{success:true,data:{transactionId:"t",status:"PAID",amount:1.1}},{success:true,data:{transactionId:"t",status:"PAID",amount:1,paidAt:"x"}}]) assert.equal(interpretarConfirmacao(body),null);
  });
  test("status HTTP é fechado",async()=>{ for(const [http,falha] of [[401,"recusada"],[403,"recusada"],[404,"nao_encontrada"],[422,"recusada"],[429,"indisponivel"],[500,"indisponivel"]] as const){ const c=criarConfirmadorBlackcat({BLACKCAT_API_KEY:"x"},async()=>new Response("{}",{status:http})); const r=await c!("t"); assert.deepEqual(r,{ok:false,falha}); } });
  test("timeout e rede não confirmam",async()=>{ for(const e of [Object.assign(new Error(),{name:"TimeoutError"}),new Error("rede")]){const c=criarConfirmadorBlackcat({BLACKCAT_API_KEY:"x"},async()=>{throw e});const r=await c!("t");assert.equal(r.ok,false);} });
});

/** O corpo que a documentação da Blackcat descreve para uma criação bem-sucedida. */
/**
 * Datas relativas ao instante do teste, e não literais.
 *
 * O PIX passou a ser recusado quando `expiresAt` já venceu, então uma data
 * fixa no fixture faria a suíte inteira começar a falhar sozinha no dia em que
 * aquela data passasse — um teste com prazo de validade é pior do que nenhum,
 * porque falha longe da mudança que o quebrou.
 */
const emHoras = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const DAQUI_A_2_DIAS = emHoras(48);

function respostaDeSucesso(sobrescrever: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      transactionId: "TXN-1733654321-ABC123",
      status: "PENDING",
      paymentMethod: "pix",
      amount: 1890,
      netAmount: 1834,
      fees: 56,
      invoiceUrl: "https://exemplo.invalido/checkout/TXN-1733654321-ABC123",
      createdAt: emHoras(0),
      paymentData: {
        qrCode: "00020126580014br.gov.bcb.pix-qr",
        qrCodeBase64: "data:image/png;base64,AAAA",
        copyPaste: "00020126580014br.gov.bcb.pix-copia",
        expiresAt: DAQUI_A_2_DIAS,
      },
      ...sobrescrever,
    },
  };
}

interface Requisicao {
  url: string;
  init: RequestInit;
  corpo: Record<string, unknown>;
}

/** Um `fetch` que registra a requisição e devolve o que o teste mandar. */
function fetchFalso(
  resposta: Response | (() => Promise<Response>),
  registro: Requisicao[] = [],
) {
  const falso = async (url: string | URL | Request, init?: RequestInit) => {
    registro.push({
      url: String(url),
      init: init ?? {},
      corpo: JSON.parse(String(init?.body ?? "{}")),
    });
    return typeof resposta === "function" ? resposta() : resposta;
  };
  return { buscar: falso as unknown as typeof fetch, registro };
}

const json = (corpo: unknown, status: number) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ── Configuração ─────────────────────────────────────────────────────────────

describe("lerConfiguracao", () => {
  /**
   * `null`, e não uma exceção com o nome da variável: quem chama transforma isto
   * num 503 genérico. "BLACKCAT_API_KEY missing" numa resposta HTTP é um oráculo
   * de configuração.
   */
  test("sem chave, devolve null", () => {
    assert.equal(lerConfiguracao({}), null);
    assert.equal(lerConfiguracao({ BLACKCAT_API_KEY: "" }), null);
    assert.equal(lerConfiguracao({ BLACKCAT_API_KEY: "   " }), null);
  });

  test("com chave, usa a base documentada", () => {
    const c = lerConfiguracao({ BLACKCAT_API_KEY: "k" });
    assert.equal(c?.baseUrl, BASE_BLACKCAT_PADRAO);
    assert.equal(c?.apiKey, "k");
  });

  test("base alternativa https é aceita, sem barra final", () => {
    const c = lerConfiguracao({
      BLACKCAT_API_KEY: "k",
      BLACKCAT_API_BASE_URL: "https://staging.exemplo.invalido/api/",
    });
    assert.equal(c?.baseUrl, "https://staging.exemplo.invalido/api");
  });

  /** `http://` mandaria a chave de API em claro. */
  test("base http é recusada", () => {
    assert.equal(
      lerConfiguracao({ BLACKCAT_API_KEY: "k", BLACKCAT_API_BASE_URL: "http://exemplo.invalido" }),
      null,
    );
  });

  test("base malformada é recusada", () => {
    assert.equal(
      lerConfiguracao({ BLACKCAT_API_KEY: "k", BLACKCAT_API_BASE_URL: "nao-e-url" }),
      null,
    );
  });

  test("base vazia cai no padrão em vez de virar erro", () => {
    const c = lerConfiguracao({ BLACKCAT_API_KEY: "k", BLACKCAT_API_BASE_URL: "" });
    assert.equal(c?.baseUrl, BASE_BLACKCAT_PADRAO);
  });
});

// ── A requisição ─────────────────────────────────────────────────────────────

describe("a requisição segue o contrato documentado", () => {
  async function chamar() {
    const { buscar, registro } = fetchFalso(json(respostaDeSucesso(), 201));
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);
    return { r, req: registro[0] };
  }

  test("vai para o endpoint documentado, montado a partir da config", async () => {
    const { req } = await chamar();
    assert.equal(req.url, `${BASE_BLACKCAT_PADRAO}/sales/create-sale`);
  });

  /**
   * Nenhum campo do pedido escolhe host, porta ou rota. É o que fecha SSRF por
   * aqui: a URL sai da configuração de servidor, sempre.
   */
  test("nada do pedido entra na URL", async () => {
    const { req } = await chamar();
    assert.equal(req.url.includes(PEDIDO.refExterna), false);
    assert.equal(req.url.includes(PEDIDO.pagador.documento.numero), false);
  });

  test("autentica por X-API-Key, e manda JSON", async () => {
    const { req } = await chamar();
    const headers = req.init.headers as Record<string, string>;
    assert.equal(headers["X-API-Key"], CONFIG.apiKey);
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(req.init.method, "POST");
  });

  test("a chave não vai para lugar nenhum além do header", async () => {
    const { req } = await chamar();
    assert.equal(JSON.stringify(req.corpo).includes(CONFIG.apiKey), false);
    assert.equal(req.url.includes(CONFIG.apiKey), false);
  });

  /**
   * Os nomes e tipos são os da documentação da Blackcat, não deduções a partir
   * dos nomes da resposta nem cópia de outro gateway.
   */
  test("o corpo usa os nomes exatos da documentação", async () => {
    const { req } = await chamar();

    assert.equal(req.corpo.amount, 1890);
    assert.ok(Number.isInteger(req.corpo.amount), "centavos, inteiro");
    assert.equal(req.corpo.currency, "BRL");
    assert.equal(req.corpo.paymentMethod, "pix");
    assert.equal(req.corpo.externalRef, PEDIDO.refExterna);

    const items = req.corpo.items as Record<string, unknown>[];
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Plus — Mensal");
    assert.equal(items[0].unitPrice, 1890);
    assert.equal(items[0].quantity, 1);
    // Produto digital: é o que dispensa o objeto `shipping`, obrigatório na
    // documentação quando algum item é `tangible: true`.
    assert.equal(items[0].tangible, false);
    assert.equal("shipping" in req.corpo, false);

    const customer = req.corpo.customer as Record<string, unknown>;
    assert.equal(customer.name, PEDIDO.pagador.nome);
    assert.equal(customer.email, PEDIDO.pagador.email);
    assert.equal(customer.phone, PEDIDO.pagador.telefone);
    assert.deepEqual(customer.document, { number: "12345678901", type: "cpf" });
  });

  /**
   * `postbackUrl` existe na documentação e **não** é enviado: webhook é Fase 5, e
   * registrar uma URL de retorno antes de existir rota que a trate criaria um
   * endpoint anunciado e não implementado.
   */
  test("não envia postbackUrl, metadata nem UTM", async () => {
    const { req } = await chamar();
    for (const campo of [
      "postbackUrl",
      "metadata",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
    ]) {
      assert.equal(campo in req.corpo, false, `${campo} não pertence a esta fase`);
    }
  });

  test("a chamada tem timeout", async () => {
    const { req } = await chamar();
    assert.ok(req.init.signal, "sem timeout, uma Blackcat lenta seguraria a função inteira");
  });
});

// ── Status HTTP ──────────────────────────────────────────────────────────────

describe("classificação do status", () => {
  /**
   * 4xx é problema do que enviamos e repetir não adianta; 5xx é do outro lado e
   * repetir pode adiantar. Nenhuma das duas vira mensagem para o usuário.
   */
  test("4xx é recusado, 5xx é indisponivel", () => {
    for (const s of [400, 401, 403, 404, 422, 429]) assert.equal(classificarStatus(s), "recusado");
    for (const s of [500, 502, 503, 504]) assert.equal(classificarStatus(s), "indisponivel");
  });

  const casos: [number, string][] = [
    [400, "recusado"],
    [401, "recusado"],
    [403, "recusado"],
    [422, "recusado"],
    [429, "recusado"],
    [500, "indisponivel"],
  ];

  for (const [status, falha] of casos) {
    test(`HTTP ${status} vira falha controlada (${falha})`, async () => {
      const { buscar } = fetchFalso(json({ success: false, message: "erro" }, status));
      const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.falha, falha);
    });
  }

  /**
   * A documentação promete 201 para criação. Aceitar 200 seria aceitar uma
   * resposta que ela não descreve — e o que viesse dentro não teria contrato.
   */
  test("200 não é sucesso de criação", async () => {
    const { buscar } = fetchFalso(json(respostaDeSucesso(), 200));
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);
    assert.equal(r.ok, false);
  });

  test("a mensagem do gateway nunca sai daqui", async () => {
    const { buscar } = fetchFalso(
      json({ success: false, message: "Dados inválidos", error: "detalhe interno" }, 422),
    );
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);

    assert.equal(r.ok, false);
    // O resultado é só `{ ok, falha }`: não há campo por onde o texto da
    // Blackcat pudesse atravessar até a rota.
    assert.deepEqual(Object.keys(r).sort(), ["falha", "ok"]);
    assert.equal(JSON.stringify(r).includes("detalhe interno"), false);
  });
});

// ── Rede ─────────────────────────────────────────────────────────────────────

describe("falhas de rede", () => {
  const lancando = (erro: Error) => {
    const buscar = (async () => {
      throw erro;
    }) as unknown as typeof fetch;
    return provedorComConfiguracao(CONFIG, buscar);
  };

  test("timeout é classificado como timeout", async () => {
    const erro = new Error("tempo esgotado");
    erro.name = "TimeoutError";
    const r = await lancando(erro).criarVenda(PEDIDO);
    assert.deepEqual(r, { ok: false, falha: "timeout" });
  });

  test("abort também é timeout", async () => {
    const erro = new Error("abortado");
    erro.name = "AbortError";
    const r = await lancando(erro).criarVenda(PEDIDO);
    assert.deepEqual(r, { ok: false, falha: "timeout" });
  });

  test("qualquer outro erro é rede, e não escapa como exceção", async () => {
    const r = await lancando(new TypeError("fetch failed")).criarVenda(PEDIDO);
    assert.deepEqual(r, { ok: false, falha: "rede" });
  });

  test("corpo que não é JSON vira resposta_invalida", async () => {
    const { buscar } = fetchFalso(new Response("<html>erro</html>", { status: 201 }));
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);
    assert.deepEqual(r, { ok: false, falha: "resposta_invalida" });
  });
});

// ── Validação da resposta ────────────────────────────────────────────────────

/** Atalho: a venda, quando a leitura deu certo. */
const vendaDe = (leitura: ReturnType<typeof interpretarVenda>) =>
  leitura.situacao === "ok" ? leitura.venda : null;

describe("interpretarVenda: nada é aceito sem conferir", () => {
  test("a resposta documentada é aceita, e normalizada", () => {
    const leitura = interpretarVenda(respostaDeSucesso());
    assert.equal(leitura.situacao, "ok");

    const venda = vendaDe(leitura);
    assert.equal(venda?.transacaoId, "TXN-1733654321-ABC123");
    assert.equal(venda?.valorCentavos, 1890);
    assert.equal(venda?.qrCode, "00020126580014br.gov.bcb.pix-qr");
    assert.equal(venda?.copiaECola, "00020126580014br.gov.bcb.pix-copia");
    assert.deepEqual(venda?.expiraEm, new Date(DAQUI_A_2_DIAS));
  });

  /**
   * `netAmount` e `fees` não concedem direito e não substituem `amount`. A
   * conferência de valor da Fase 5 é contra `amount`, e é por isso que ele é o
   * único que este módulo extrai. `status` também não entra: ele decide se a
   * leitura é `ok`, e não acompanha a venda para dentro do serviço.
   */
  test("netAmount, fees, invoiceUrl e status não entram no resultado", () => {
    const venda = vendaDe(interpretarVenda(respostaDeSucesso())) as object;
    for (const campo of ["netAmount", "fees", "invoiceUrl", "status"]) {
      assert.equal(campo in venda, false, `${campo} não pertence ao resultado`);
    }
  });

  /**
   * Sem `transactionId` não há o que investigar depois: `invalida`, e o serviço
   * marca `FALHOU`. É a única categoria em que isso vale.
   */
  const invalidas: [string, unknown][] = [
    ["null", null],
    ["texto", "ok"],
    ["sem data", { success: true }],
    ["data que não é objeto", { success: true, data: "x" }],
    ["sem transactionId", respostaDeSucesso({ transactionId: undefined })],
    ["transactionId vazio", respostaDeSucesso({ transactionId: "   " })],
    ["transactionId numérico", respostaDeSucesso({ transactionId: 123 })],
  ];

  for (const [nome, payload] of invalidas) {
    test(`invalida (sem transação para investigar): ${nome}`, () => {
      assert.deepEqual(interpretarVenda(payload), { situacao: "invalida" });
    });
  }

  /**
   * Com `transactionId`, existe uma venda no provedor. A leitura recusa, mas
   * **carrega a transação** — é o que faz o serviço escolher `REVISAO_MANUAL`
   * em vez de `FALHOU`, e o que permite a Fase 5 investigar em vez de descartar.
   */
  const recusadas: [string, unknown, string][] = [
    ["amount ausente", respostaDeSucesso({ amount: undefined }), "resposta_incompleta"],
    ["amount como string", respostaDeSucesso({ amount: "1890" }), "resposta_incompleta"],
    ["amount fracionário", respostaDeSucesso({ amount: 18.9 }), "resposta_incompleta"],
    ["sem paymentData", respostaDeSucesso({ paymentData: undefined }), "resposta_incompleta"],
    [
      // Nenhuma representação de QR (nem `qrCode` nem `qrCodeBase64`): aí não há
      // como o cliente desenhar nem exibir o QR, e a recusa é correta. Ter uma
      // das duas basta — ver os casos aceitos adiante.
      "sem nenhuma representação de QR",
      respostaDeSucesso({ paymentData: { copyPaste: "c", expiresAt: DAQUI_A_2_DIAS } }),
      "resposta_incompleta",
    ],
    [
      "sem copyPaste",
      respostaDeSucesso({ paymentData: { qrCode: "q", expiresAt: DAQUI_A_2_DIAS } }),
      "resposta_incompleta",
    ],
    [
      "sem expiresAt",
      respostaDeSucesso({ paymentData: { qrCode: "q", copyPaste: "c" } }),
      "resposta_incompleta",
    ],
    [
      "expiresAt impossível de interpretar",
      respostaDeSucesso({ paymentData: { qrCode: "q", copyPaste: "c", expiresAt: "ontem" } }),
      "resposta_incompleta",
    ],
  ];

  for (const [nome, payload, falha] of recusadas) {
    test(`recusada com transação (${falha}): ${nome}`, () => {
      const leitura = interpretarVenda(payload);
      assert.equal(leitura.situacao, "recusada");
      assert.equal(leitura.situacao === "recusada" && leitura.falha, falha);
      assert.equal(
        leitura.situacao === "recusada" && leitura.transacaoId,
        "TXN-1733654321-ABC123",
        "a transação precisa sobreviver à recusa, ou a Fase 5 não a encontra",
      );
    });
  }

  /**
   * `copyPaste` é obrigatório e insubstituível; além dele basta **uma**
   * representação de QR. Aqui vem `qrCode` sem `qrCodeBase64`: a venda é aceita,
   * e o `qrCodeBase64` fica `null` — nesse caso o checkout mostra só o
   * copia-e-cola, sem imagem. (Requisito 5.)
   */
  test("qrCodeBase64 ausente não invalida a venda (qrCode presente)", () => {
    const leitura = interpretarVenda(
      respostaDeSucesso({
        paymentData: { qrCode: "q", copyPaste: "c", expiresAt: DAQUI_A_2_DIAS },
      }),
    );
    assert.equal(leitura.situacao, "ok");
    assert.equal(vendaDe(leitura)?.qrCodeBase64, null);
  });

  /**
   * O espelho do caso acima, e a correção que motiva a branch: `qrCode` ausente
   * mas `qrCodeBase64` presente é uma resposta funcionalmente completa — o
   * checkout desenha a imagem a partir do `qrCodeBase64`. Antes isto ia para
   * REVISAO_MANUAL sem necessidade. (Requisito 4.)
   */
  test("qrCode ausente + qrCodeBase64 válido + copyPaste válido é aceito", () => {
    const leitura = interpretarVenda(
      respostaDeSucesso({
        paymentData: {
          qrCodeBase64: "data:image/png;base64,AAAA",
          copyPaste: "c",
          expiresAt: DAQUI_A_2_DIAS,
        },
      }),
    );
    assert.equal(leitura.situacao, "ok");
    assert.equal(vendaDe(leitura)?.qrCode, "");
    assert.equal(vendaDe(leitura)?.qrCodeBase64, "data:image/png;base64,AAAA");
  });

  /**
   * `qrCodeBase64` é normalizado só no trim — o conteúdo sensível não é tocado.
   */
  test("qrCodeBase64 é preservado sem alterar o conteúdo (só trim)", () => {
    const leitura = interpretarVenda(
      respostaDeSucesso({
        paymentData: {
          qrCode: "q",
          qrCodeBase64: "  data:image/png;base64,ZZZZ  ",
          copyPaste: "c",
          expiresAt: DAQUI_A_2_DIAS,
        },
      }),
    );
    assert.equal(vendaDe(leitura)?.qrCodeBase64, "data:image/png;base64,ZZZZ");
  });

  /**
   * Requisito 7: uma recusa por PIX incompleto **preserva** o `expiresAt` do
   * provedor em `expiraEm`, desde que a data em si seja válida. É o que impede a
   * revisão de nascer sem prazo — sem `expiraEm`, `confirmar_nao_pago` não
   * resolve um `PENDING` por expiração e o caso fica preso.
   */
  test("recusa com transação e expiresAt válido carrega expiraEm", () => {
    // Sem nenhuma representação de QR → recusada, mas com prazo válido.
    const leitura = interpretarVenda(
      respostaDeSucesso({ paymentData: { copyPaste: "c", expiresAt: DAQUI_A_2_DIAS } }),
    );
    assert.equal(leitura.situacao, "recusada");
    assert.equal(leitura.situacao === "recusada" && leitura.falha, "resposta_incompleta");
    assert.equal(
      leitura.situacao === "recusada" && leitura.transacaoId,
      "TXN-1733654321-ABC123",
    );
    assert.deepEqual(
      leitura.situacao === "recusada" ? leitura.expiraEm : null,
      new Date(DAQUI_A_2_DIAS),
    );
  });

  /**
   * Já um `expiresAt` inválido não vira `expiraEm`: não há prazo a preservar, e
   * inventar um seria fabricar informação de reconciliação.
   */
  test("recusa com expiresAt inválido não carrega expiraEm", () => {
    const leitura = interpretarVenda(
      respostaDeSucesso({ paymentData: { copyPaste: "c", expiresAt: "ontem" } }),
    );
    assert.equal(leitura.situacao, "recusada");
    assert.equal(leitura.situacao === "recusada" && leitura.expiraEm, undefined);
  });

  /**
   * O provedor devolve a venda ao serviço já com `expiraEm` no ramo de falha,
   * para `criarPedidoPix` persistir junto da transação na revisão.
   */
  test("criarVenda propaga expiraEm na recusa com transação", async () => {
    const { buscar } = fetchFalso(
      json(respostaDeSucesso({ paymentData: { copyPaste: "c", expiresAt: DAQUI_A_2_DIAS } }), 201),
    );
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.transacaoId, "TXN-1733654321-ABC123");
    assert.deepEqual(r.ok === false ? r.expiraEm : null, new Date(DAQUI_A_2_DIAS));
  });
});

/**
 * **O bloco que HTTP 201 sozinho não cobria.**
 *
 * `201` diz que a requisição foi aceita; `data.status` diz em que estado a venda
 * nasceu. Só `PENDING` é criação normal. Antes desta correção o campo não era
 * lido, e uma venda que chegasse `PAID` na resposta de criação teria devolvido
 * PIX como sucesso — o primeiro passo do caminho que ativa assinatura sem
 * confirmação servidor→servidor.
 */
describe("status da criação: só PENDING é sucesso", () => {
  test("PENDING é aceito", () => {
    assert.equal(STATUS_DE_CRIACAO_ACEITO, "PENDING");
    assert.equal(interpretarVenda(respostaDeSucesso({ status: "PENDING" })).situacao, "ok");
  });

  const inesperados: [string, unknown][] = [
    ["PAID", "PAID"],
    ["CANCELLED", "CANCELLED"],
    ["REFUNDED", "REFUNDED"],
    ["desconhecido", "PROCESSANDO"],
    ["ausente", undefined],
    ["nulo", null],
    ["numérico", 1],
    ["minúsculo (sem normalização permissiva)", "pending"],
    ["com espaço em volta", " PENDING "],
  ];

  for (const [nome, status] of inesperados) {
    test(`${nome}: não é criação bem-sucedida`, () => {
      const leitura = interpretarVenda(respostaDeSucesso({ status }));

      assert.notEqual(leitura.situacao, "ok", "não pode devolver PIX como sucesso");
      assert.equal(leitura.situacao, "recusada");
      assert.equal(
        leitura.situacao === "recusada" && leitura.falha,
        "estado_externo_inesperado",
      );
      // A transação existe: a Fase 5 precisa poder investigá-la.
      assert.equal(
        leitura.situacao === "recusada" && leitura.transacaoId,
        "TXN-1733654321-ABC123",
      );
    });
  }

  /** O caso mais perigoso, isolado e dito por extenso. */
  test('"PAID" na criação nunca vira sucesso nem chega ao serviço como venda', async () => {
    const { buscar } = fetchFalso(json(respostaDeSucesso({ status: "PAID" }), 201));
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.falha, "estado_externo_inesperado");
    assert.equal(r.ok === false && r.transacaoId, "TXN-1733654321-ABC123");
    assert.equal(JSON.stringify(r).includes("PAID"), false, "o estado externo não vaza");
  });

  test("201 é necessário, não suficiente", async () => {
    for (const status of ["PAID", "CANCELLED", "REFUNDED", "QUALQUER"]) {
      const { buscar } = fetchFalso(json(respostaDeSucesso({ status }), 201));
      const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);
      assert.equal(r.ok, false, `${status} com HTTP 201 não pode passar`);
    }
  });
});

describe("expiresAt precisa estar no futuro", () => {
  test("data futura é aceita", () => {
    const leitura = interpretarVenda(
      respostaDeSucesso({
        paymentData: { qrCode: "q", copyPaste: "c", expiresAt: emHoras(1) },
      }),
    );
    assert.equal(leitura.situacao, "ok");
  });

  /**
   * Um PIX que já nasce vencido não é pagável: entregá-lo seria mandar o usuário
   * tentar pagar algo que o provedor já recusa. É estado externo inesperado, não
   * resposta malformada — a resposta está bem formada; errado é o que ela diz.
   */
  test("data passada não é sucesso", () => {
    const leitura = interpretarVenda(
      respostaDeSucesso({
        paymentData: { qrCode: "q", copyPaste: "c", expiresAt: emHoras(-1) },
      }),
    );
    assert.notEqual(leitura.situacao, "ok");
    assert.equal(
      leitura.situacao === "recusada" && leitura.falha,
      "estado_externo_inesperado",
    );
    assert.equal(
      leitura.situacao === "recusada" && leitura.transacaoId,
      "TXN-1733654321-ABC123",
    );
  });

  /** `<=` e não `<`: expirar exatamente agora já não dá tempo de pagar. */
  test("expirar exatamente agora não é sucesso", () => {
    const agora = new Date("2026-09-10T12:00:00.000Z");
    const leitura = interpretarVenda(
      respostaDeSucesso({
        paymentData: { qrCode: "q", copyPaste: "c", expiresAt: agora.toISOString() },
      }),
      agora,
    );
    assert.notEqual(leitura.situacao, "ok");
  });

  test("a comparação usa o relógio injetado, não o do processo", () => {
    // A mesma data é futuro para um instante e passado para o outro.
    const payload = respostaDeSucesso({
      paymentData: { qrCode: "q", copyPaste: "c", expiresAt: "2026-09-10T12:00:00.000Z" },
    });

    assert.equal(interpretarVenda(payload, new Date("2026-09-10T11:59:59.000Z")).situacao, "ok");
    assert.notEqual(
      interpretarVenda(payload, new Date("2026-09-10T12:00:01.000Z")).situacao,
      "ok",
    );
  });

  test("PIX vencido chega ao serviço com a transação, para virar REVISAO_MANUAL", async () => {
    const { buscar } = fetchFalso(
      json(
        respostaDeSucesso({
          paymentData: { qrCode: "q", copyPaste: "c", expiresAt: emHoras(-24) },
        }),
        201,
      ),
    );
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.falha, "estado_externo_inesperado");
    assert.equal(r.ok === false && r.transacaoId, "TXN-1733654321-ABC123");
  });
});

describe("da resposta ao resultado do provedor", () => {
  test("sem transactionId: resposta_invalida, e SEM transação", async () => {
    const { buscar } = fetchFalso(json(respostaDeSucesso({ transactionId: "" }), 201));
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);
    assert.deepEqual(r, { ok: false, falha: "resposta_invalida" });
  });

  test("PIX incompleto com transactionId: resposta_incompleta, COM transação", async () => {
    const { buscar } = fetchFalso(
      json(respostaDeSucesso({ paymentData: { expiresAt: DAQUI_A_2_DIAS } }), 201),
    );
    const r = await provedorComConfiguracao(CONFIG, buscar).criarVenda(PEDIDO);

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.falha, "resposta_incompleta");
    assert.equal(r.ok === false && r.transacaoId, "TXN-1733654321-ABC123");
  });

  /**
   * A regra única do módulo, verificada de uma vez: falha antes de conhecer a
   * transação não carrega `transacaoId`; falha depois, carrega.
   */
  test("timeout, 5xx e 4xx nunca carregam transação", async () => {
    const lancandoTimeout = (async () => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;

    const semTransacao = [
      await provedorComConfiguracao(CONFIG, lancandoTimeout).criarVenda(PEDIDO),
      await provedorComConfiguracao(CONFIG, fetchFalso(json({}, 500)).buscar).criarVenda(PEDIDO),
      await provedorComConfiguracao(CONFIG, fetchFalso(json({}, 422)).buscar).criarVenda(PEDIDO),
    ];

    for (const r of semTransacao) {
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.transacaoId, undefined);
    }
  });
});
