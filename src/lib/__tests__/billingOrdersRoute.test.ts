import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  identificadorComercial,
  montarPagador,
  soDigitos,
} from "../billing/pagador";

/**
 * `POST /api/billing/orders`.
 *
 * Duas metades, e vale dizer o que cada uma prova:
 *
 *   1. **A fronteira de confiança**, exercitada de verdade. `montarPagador` e
 *      `identificadorComercial` são funções puras porque foram tiradas do
 *      arquivo de rota justamente para isto — um módulo do App Router só exporta
 *      os verbos HTTP, e nada deixado lá seria alcançável daqui.
 *
 *   2. **A forma da rota**, lida do fonte. Isto prova que a checagem aparece
 *      antes do trabalho caro, e que segredo e payload não aparecem na resposta.
 *      Não prova execução: quem envolver a flag num `if` sempre falso passa por
 *      estes testes. O que eles pegam é a regressão real e provável — mover a
 *      verificação para depois da escrita, ou devolver um campo a mais.
 *
 * Mesmo critério (e mesma honestidade sobre o alcance) de
 * `playbackAuthorization.test.ts`, que faz o equivalente em `/api/player/fontes`.
 */

const rota = readFileSync(
  join(process.cwd(), "src/app/api/billing/orders/route.ts"),
  "utf8",
);

/**
 * Só código, sem comentários.
 *
 * Os comentários desta rota descrevem a própria regra, e por isso citam
 * `transactionId`, `BLACKCAT_API_KEY`, `Assinatura` e `PAGO` exatamente ao dizer
 * que **não** é isso que ela faz. Sem removê-los, as verificações negativas
 * abaixo acusariam a documentação como se fosse implementação.
 */
const codigo = (() => {
  let dentroDeBloco = false;
  return rota
    .split("\n")
    .filter((linha) => {
      const t = linha.trimStart();
      if (dentroDeBloco) {
        if (t.includes("*/")) dentroDeBloco = false;
        return false;
      }
      if (t.startsWith("/*")) {
        dentroDeBloco = !t.includes("*/");
        return false;
      }
      return !t.startsWith("//");
    })
    .join("\n");
})();

/**
 * O corpo do handler, sem o bloco de imports.
 *
 * As comparações de ordem abaixo procuram *chamadas*, e todo nome chamado
 * aparece antes no `import` — `readJsonBody` no topo do arquivo precederia a
 * flag e faria a verificação de ordem sempre falhar (ou, pior, sempre passar,
 * dependendo do lado da comparação). Cortar no `export async function POST`
 * deixa só o fluxo de execução.
 */
const handler = codigo.slice(codigo.indexOf("export async function POST"));

const posicaoDe = (trecho: string) => {
  const i = handler.indexOf(trecho);
  assert.notEqual(i, -1, `"${trecho}" não foi encontrado no handler`);
  return i;
};

// ── Fronteira de confiança: identificadores ──────────────────────────────────

describe("identificadorComercial", () => {
  test("aceita slug e cuid, que é o que o schema usa", () => {
    assert.equal(identificadorComercial("plus"), "plus");
    assert.equal(identificadorComercial("clx1a2b3c4d5e6f7g8h9"), "clx1a2b3c4d5e6f7g8h9");
    assert.equal(identificadorComercial("plano_anual-2026"), "plano_anual-2026");
    assert.equal(identificadorComercial("  plus  "), "plus");
  });

  test("recusa o que não é identificador", () => {
    for (const v of [null, undefined, 1, {}, [], true, "", "   "]) {
      assert.equal(identificadorComercial(v), null, `${JSON.stringify(v)} não é identificador`);
    }
  });

  /**
   * O campo vira chave de consulta ao Postgres. Um valor de tamanho arbitrário
   * ou com caracteres de fora do conjunto não tem por que chegar até lá.
   */
  test("recusa formato inesperado e tamanho fora do teto", () => {
    for (const v of ["plus plus", "plus;drop", "../etc", "plano/1", "a".repeat(65), "%20"]) {
      assert.equal(identificadorComercial(v), null, `${v} deveria ser recusado`);
    }
    assert.equal(identificadorComercial("a".repeat(64)), "a".repeat(64));
  });
});

// ── Fronteira de confiança: pagador ──────────────────────────────────────────

describe("soDigitos", () => {
  test("extrai só os dígitos", () => {
    assert.equal(soDigitos("(11) 99999-9999"), "11999999999");
    assert.equal(soDigitos("123.456.789-01"), "12345678901");
    assert.equal(soDigitos(12345), "");
    assert.equal(soDigitos(null), "");
  });
});

describe("montarPagador: o que vem da conta e o que vem do corpo", () => {
  const CONTA = { nome: "Fulano de Tal", email: "fulano@example.test" };
  const CORPO = { documento: "123.456.789-01", telefone: "(11) 99999-9999" };

  test("caso normal: conta dá nome e e-mail, corpo dá documento e telefone", () => {
    assert.deepEqual(montarPagador(CONTA, CORPO), {
      nome: "Fulano de Tal",
      email: "fulano@example.test",
      telefone: "11999999999",
      documento: { numero: "12345678901", tipo: "cpf" },
    });
  });

  /**
   * O teste que trava a fraude mais óbvia desta rota: emitir fatura em nome de
   * outra pessoa a partir da própria sessão.
   */
  test("o e-mail NUNCA vem do corpo", () => {
    const p = montarPagador(CONTA, {
      ...CORPO,
      email: "vitima@example.test",
    } as Record<string, unknown>);
    assert.equal(p?.email, "fulano@example.test");
  });

  test("o nome da conta tem precedência sobre o do corpo", () => {
    const p = montarPagador(CONTA, { ...CORPO, nome: "Outro Nome" });
    assert.equal(p?.nome, "Fulano de Tal");
  });

  /**
   * `User.nome` é nullable — o cadastro por e-mail aceita conta sem nome — e a
   * Blackcat exige o campo. Sem o fallback, essas contas simplesmente não
   * conseguiriam pagar.
   */
  test("conta sem nome usa o do corpo, que é o único caso em que ele conta", () => {
    const p = montarPagador({ nome: null, email: "x@example.test" }, { ...CORPO, nome: "Beltrano" });
    assert.equal(p?.nome, "Beltrano");

    const vazio = montarPagador({ nome: "   ", email: "x@example.test" }, { ...CORPO, nome: "Beltrano" });
    assert.equal(vazio?.nome, "Beltrano");
  });

  test("sem nome em lugar nenhum, recusa", () => {
    assert.equal(montarPagador({ nome: null, email: "x@example.test" }, CORPO), null);
    assert.equal(montarPagador({ nome: null, email: "x@example.test" }, { ...CORPO, nome: "A" }), null);
  });

  test("o nome é truncado, não rejeitado por comprimento", () => {
    const p = montarPagador({ nome: "N".repeat(200), email: "x@example.test" }, CORPO);
    assert.equal(p?.nome.length, 80);
  });

  /** O tipo sai do comprimento, e não de um campo que o cliente escolhe. */
  test("11 dígitos é CPF, 14 é CNPJ", () => {
    assert.equal(montarPagador(CONTA, { ...CORPO, documento: "12345678901" })?.documento.tipo, "cpf");
    assert.equal(
      montarPagador(CONTA, { ...CORPO, documento: "12.345.678/0001-90" })?.documento.tipo,
      "cnpj",
    );
  });

  test("um tipo declarado pelo cliente é ignorado", () => {
    const p = montarPagador(CONTA, {
      ...CORPO,
      documento: "12345678901",
      documentoTipo: "cnpj",
    } as Record<string, unknown>);
    assert.equal(p?.documento.tipo, "cpf");
  });

  test("documento com comprimento inválido recusa", () => {
    for (const doc of ["123", "1234567890", "123456789012", "", "abc.def"]) {
      assert.equal(montarPagador(CONTA, { ...CORPO, documento: doc }), null, `${doc} deveria recusar`);
    }
  });

  test("telefone fora de 10–11 dígitos recusa", () => {
    for (const tel of ["999999999", "119999999999", "", "abc"]) {
      assert.equal(montarPagador(CONTA, { ...CORPO, telefone: tel }), null, `${tel} deveria recusar`);
    }
    assert.ok(montarPagador(CONTA, { ...CORPO, telefone: "1133334444" }), "fixo com DDD é válido");
  });

  test("campos ausentes recusam em vez de virar string vazia", () => {
    assert.equal(montarPagador(CONTA, {}), null);
    assert.equal(montarPagador(CONTA, { documento: "12345678901" }), null);
    assert.equal(montarPagador(CONTA, { telefone: "11999999999" }), null);
  });
});

// ── A forma da rota ──────────────────────────────────────────────────────────

describe("a rota só existe como POST", () => {
  test("exporta POST", () => {
    assert.match(codigo, /export async function POST\s*\(/);
  });

  /**
   * Consultar estado de pedido é polling, e polling pertence à fase que tem o
   * que consultar. Um `GET` aqui hoje devolveria um estado que nada atualiza.
   */
  test("não exporta GET, PUT, PATCH nem DELETE", () => {
    for (const verbo of ["GET", "PUT", "PATCH", "DELETE"]) {
      assert.equal(
        new RegExp(`export (async )?function ${verbo}\\s*\\(`).test(codigo),
        false,
        `${verbo} não pertence a esta fase`,
      );
    }
  });
});

describe("ordem das verificações", () => {
  /**
   * A flag é a primeira linha do handler, antes de qualquer leitura. Desligada,
   * a rota não consulta banco, não resolve Redis e não chama a Blackcat.
   */
  test("a flag é cobrada antes de tudo", () => {
    const flag = posicaoDe("cobrancaPixAtiva()");
    for (const depois of [
      "getUserFromRequest(req)",
      "checkRateLimit(",
      "readJsonBody",
      "prisma.user.findUnique",
      "criarProvedorBlackcat()",
      "criarPedidoPix(",
    ]) {
      assert.ok(flag < posicaoDe(depois), `${depois} não pode acontecer antes da flag`);
    }
  });

  test("origem e sessão vêm antes do corpo e do limite", () => {
    const origem = posicaoDe("headerMatchesHost(origin, host)");
    const sessao = posicaoDe("getUserFromRequest(req)");
    assert.ok(origem < sessao, "origem antes de resolver sessão");
    assert.ok(sessao < posicaoDe("checkRateLimit("), "não se limita quem não se autenticou");
    assert.ok(sessao < posicaoDe("readJsonBody"));
  });

  test("o limite é cobrado antes de ler o corpo", () => {
    assert.ok(posicaoDe("checkRateLimit(") < posicaoDe("readJsonBody"));
  });

  /**
   * Falta de chave de API é falha de configuração nossa, e não pode deixar linha
   * de cobrança pendurada no banco.
   */
  test("o provedor é montado antes de qualquer escrita", () => {
    assert.ok(posicaoDe("criarProvedorBlackcat()") < posicaoDe("criarPedidoPix("));
  });

  test("os campos financeiros são recusados antes de resolver preço", () => {
    assert.ok(posicaoDe("campoFinanceiroNoCorpo(") < posicaoDe("criarPedidoPix("));
  });
});

describe("limites", () => {
  test("5 por hora por conta, 20 por hora por IP", () => {
    assert.match(codigo, /LIMITE_POR_CONTA\s*=\s*5\b/);
    assert.match(codigo, /LIMITE_POR_IP\s*=\s*20\b/);
    assert.match(codigo, /JANELA_SEGUNDOS\s*=\s*3600\b/);
  });

  test("as chaves são namespaced em billing", () => {
    assert.ok(codigo.includes("billing:orders:user:"));
    assert.ok(codigo.includes("billing:orders:ip:"));
  });

  /**
   * `checkRateLimit` resolve o Redis por dentro, e em produção sem Upstash
   * `getRedis()` lança. Dinheiro não falha aberto: o `catch` precisa recusar, e
   * a recusa precisa ser a resposta genérica.
   */
  test("falha do Redis recusa, em vez de deixar passar", () => {
    const bloco = handler.slice(posicaoDe("checkRateLimit("), posicaoDe("readJsonBody"));
    assert.ok(bloco.includes("catch"), "a falha de Redis precisa ser tratada");
    assert.ok(bloco.includes("INDISPONIVEL()"), "e precisa recusar");
  });
});

describe("a resposta não vaza nada", () => {
  const corpoDaResposta = handler.slice(posicaoDe("NextResponse.json(\n    {\n      pedidoId"));

  /**
   * O cliente trabalha com o **nosso** `pedidoId`. O `transactionId` da Blackcat
   * não lhe serve para nada e é justamente o identificador que a Fase 5 usa para
   * casar confirmação com pedido.
   */
  test("não devolve transactionId, netAmount, fees nem invoiceUrl", () => {
    for (const campo of ["transacaoId", "transactionId", "netAmount", "fees", "invoiceUrl", "refExterna"]) {
      assert.equal(
        corpoDaResposta.includes(campo),
        false,
        `${campo} não pertence à resposta do cliente`,
      );
    }
  });

  test("devolve exatamente o contrato combinado", () => {
    for (const campo of ["pedidoId", "status", "valorCentavos", "moeda", "expiraEm", "qrCode", "copiaECola"]) {
      assert.ok(corpoDaResposta.includes(campo), `${campo} faltou na resposta`);
    }
  });

  test("toda resposta é no-store", () => {
    assert.match(codigo, /NO_STORE\s*=\s*\{\s*"Cache-Control":\s*"no-store/);
    // `erro()` e o sucesso são os dois únicos pontos que constroem resposta, e
    // os dois passam NO_STORE.
    const respostas = codigo.match(/NextResponse\.json\(/g) ?? [];
    const comNoStore = codigo.match(/headers:\s*NO_STORE/g) ?? [];
    assert.equal(respostas.length, comNoStore.length, "toda resposta precisa de NO_STORE");
  });

  /**
   * A chave nunca é lida nem mencionada por esta rota: ela vive em
   * `billing/blackcat.ts` e só aparece no header `X-API-Key`.
   */
  test("a rota não toca em segredo nem em URL do provedor", () => {
    for (const proibido of [
      "BLACKCAT_API_KEY",
      "BLACKCAT_API_BASE_URL",
      "X-API-Key",
      "blackcatoficial",
      "process.env",
    ]) {
      assert.equal(codigo.includes(proibido), false, `${proibido} não pode aparecer na rota`);
    }
  });

  /**
   * Nenhuma mensagem do gateway, nenhum stack, nenhum SQL, nenhum nome de
   * variável de ambiente. `cobranca_indisponivel` é a mesma resposta para flag
   * desligada, chave ausente e Redis fora — distinguir daria um oráculo de
   * configuração a quem estiver sondando.
   */
  test("o erro não é oráculo: as três indisponibilidades respondem igual", () => {
    const indisponiveis = codigo.match(/INDISPONIVEL\(\)/g) ?? [];
    assert.ok(indisponiveis.length >= 4, "flag, limite, provedor e erro interno");
    assert.match(codigo, /cobranca_indisponivel/);
    for (const vazamento of ["erro.message", "e.message", "String(erro)", "stack"]) {
      assert.equal(codigo.includes(vazamento), false, `${vazamento} não pode ir para a resposta`);
    }
  });
});

describe("a rota não decide nada de comercial por conta própria", () => {
  /**
   * Se um `if (preco.ativo)` ou um `planoId === "premium"` aparecer aqui, a
   * regra passou a viver em dois lugares — e o segundo é o que ninguém testa.
   */
  test("a regra vive em billing/pedidos, não na rota", () => {
    for (const proibido of [
      "valorCentavos =",
      "duracaoDias =",
      "resolverPreco(",
      '"premium"',
      '"gratuito"',
    ]) {
      assert.equal(codigo.includes(proibido), false, `${proibido} não deve aparecer na rota`);
    }
  });

  /**
   * `precoCentavos` aparece uma vez, e legitimamente: no `select` do
   * repositório, porque a coluna precisa ser lida. O que não pode existir é a
   * rota **fazer conta ou comparação** com ela — aí o valor teria passado a ser
   * decidido em dois lugares.
   */
  test("a rota lê o preço, mas não opera sobre ele", () => {
    assert.equal(
      /precoCentavos\s*[<>=!+*/-]/.test(codigo),
      false,
      "nenhuma comparação ou aritmética de preço pertence à rota",
    );
    assert.equal((codigo.match(/precoCentavos/g) ?? []).length, 1, "só no select");
  });

  /** A promessa da fase, mais uma vez, no lugar onde seria mais tentador quebrá-la. */
  test("a rota não cria assinatura nem invalida entitlements", () => {
    for (const proibido of [
      "assinatura.create",
      "assinatura.update",
      "invalidarEntitlements",
      "entitlementsDoUsuario",
      "PAGO",
    ]) {
      assert.equal(codigo.includes(proibido), false, `${proibido} não pertence a esta fase`);
    }
  });

  test("as únicas escritas no banco são de PedidoPagamento", () => {
    const escritas = codigo.match(/prisma\.\w+\.(create|update|upsert|delete)/g) ?? [];
    for (const escrita of escritas) {
      assert.ok(
        escrita.startsWith("prisma.pedidoPagamento."),
        `${escrita} escreve fora de PedidoPagamento`,
      );
    }
    assert.ok(escritas.length > 0, "a rota precisa escrever o pedido");
  });

  test("o pedido nasce CRIADO e só passa a AGUARDANDO com transacaoId", () => {
    assert.match(codigo, /status:\s*"AGUARDANDO",\s*transacaoId/);
    assert.equal(/status:\s*"PAGO"/.test(codigo), false);
  });
});
