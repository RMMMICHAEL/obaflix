import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PROVEDORES_PAGAMENTO, STATUS_PEDIDO } from "../billing/pedidos";

/**
 * O que a Fase 4 promete ao banco.
 *
 * Mesmo mecanismo de `planos.test.ts`: o domínio dos campos de texto vive em
 * dois lugares — as constantes de `billing/pedidos.ts` e os `CHECK` da
 * migration — e dois lugares divergem. Um teste que lê os dois arquivos não
 * deixa, e a divergência quebra o CI em vez da produção.
 *
 * Sejamos exatos sobre o alcance: estes testes leem SQL e schema como texto.
 * Provam que a migration **declara** o que deveria declarar; não provam que ela
 * foi executada. Quem prova execução é
 * `prisma/migrations/20260910_pedido_pagamento/VERIFICACAO.sql`, contra o
 * Postgres de verdade. As duas coisas são necessárias e nenhuma substitui a
 * outra.
 */

const raiz = process.cwd();
const migracao = readFileSync(
  join(raiz, "prisma/migrations/20260910_pedido_pagamento/migration.sql"),
  "utf8",
);
const rollback = readFileSync(
  join(raiz, "prisma/migrations/20260910_pedido_pagamento/ROLLBACK.sql"),
  "utf8",
);
const schema = readFileSync(join(raiz, "prisma/schema.prisma"), "utf8");

/**
 * O SQL sem os comentários de linha inteira.
 *
 * Necessário pelo mesmo motivo de `playbackAuthorization.test.ts`: os
 * comentários destes arquivos explicam a própria regra, e por isso citam
 * `CASCADE`, `DELETE FROM`, `anon`/`authenticated` e `DROP TABLE ... CASCADE`
 * justamente ao dizer que **não** é isso que o SQL faz. Sem removê-los, as
 * verificações negativas abaixo estariam lendo prosa e acusando a documentação
 * como se fosse implementação.
 */
function soCodigo(sql: string): string {
  return sql
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("--"))
    .join("\n");
}

const migracaoCodigo = soCodigo(migracao);
const rollbackCodigo = soCodigo(rollback);

/** O bloco `model X { ... }` do schema, para os asserts não pegarem outro modelo. */
function modelo(nome: string): string {
  const inicio = schema.indexOf(`model ${nome} {`);
  assert.notEqual(inicio, -1, `model ${nome} não existe no schema`);
  const fim = schema.indexOf("\n}", inicio);
  assert.notEqual(fim, -1, `model ${nome} não fecha`);
  return schema.slice(inicio, fim);
}

describe("PedidoPagamento existe, e com os tipos certos", () => {
  const pedido = modelo("PedidoPagamento");

  test("o modelo está no schema", () => {
    assert.ok(pedido.includes("model PedidoPagamento {"));
  });

  /**
   * O teste que trava o erro mais caro possível nesta tabela.
   *
   * `Float` ou `Decimal` aqui significaria dinheiro em ponto flutuante: 8,90 não
   * existe em binário, e o erro apareceria justamente na conferência entre valor
   * pago e valor esperado da Fase 5 — o único lugar onde ele custa dinheiro de
   * verdade e o último onde alguém pensaria em procurar.
   */
  test("valorCentavos é Int — centavos, nunca float", () => {
    assert.match(pedido, /\n\s*valorCentavos\s+Int\b/);
    assert.doesNotMatch(pedido, /valorCentavos\s+(Float|Decimal|String)/);
    assert.ok(
      migracaoCodigo.includes('"valorCentavos" INTEGER NOT NULL'),
      "a coluna precisa ser INTEGER no SQL também",
    );
  });

  test("duracaoDias é snapshot no pedido, e é Int", () => {
    assert.match(pedido, /\n\s*duracaoDias\s+Int\b/);
    assert.ok(migracaoCodigo.includes('"duracaoDias" INTEGER NOT NULL'));
  });

  /**
   * Snapshot é o ponto inteiro destas duas colunas.
   *
   * Sem elas, a Fase 5 conferiria o valor pago contra `PlanoPreco` — e uma
   * alteração de preço entre a criação do PIX e o pagamento faria a conferência
   * recusar um pagamento correto, ou aceitar um incorreto.
   */
  test("valor e duração são NOT NULL — um pedido sem snapshot não existe", () => {
    for (const coluna of ['"valorCentavos" INTEGER NOT NULL', '"duracaoDias" INTEGER NOT NULL']) {
      assert.ok(migracaoCodigo.includes(coluna), `${coluna} precisa ser NOT NULL`);
    }
  });

  test("planoPrecoId é obrigatório — todo pedido nasce de um preço", () => {
    assert.match(pedido, /\n\s*planoPrecoId\s+String\b(?!\?)/);
    assert.ok(migracaoCodigo.includes('"planoPrecoId" TEXT NOT NULL'));
  });

  test("transacaoId é opcional — nulo até a Blackcat responder", () => {
    assert.match(pedido, /\n\s*transacaoId\s+String\?/);
    assert.ok(
      migracaoCodigo.includes('"transacaoId" TEXT,'),
      "no SQL a coluna precisa aceitar NULL",
    );
  });
});

describe("uniques", () => {
  const pedido = modelo("PedidoPagamento");

  /**
   * Duas gerações colidindo não seria cosmético: dois pedidos com a mesma
   * referência tornariam ambíguo qual venda da Blackcat pertence a qual pedido
   * — exatamente a pergunta que a reconciliação da Fase 5 precisa responder.
   */
  test("refExterna é única, no schema e no banco", () => {
    assert.match(pedido, /\n\s*refExterna\s+String\s+@unique/);
    assert.ok(
      migracaoCodigo.includes('CREATE UNIQUE INDEX IF NOT EXISTS "PedidoPagamento_refExterna_key"'),
    );
  });

  /**
   * É esta trava que impede a Fase 5 de ativar duas assinaturas a partir da
   * mesma transação — no banco, e não em `if`. O Postgres aceita vários NULL num
   * índice único, então "todo pedido nasce sem transação" e "uma transação
   * pertence a no máximo um pedido" convivem sem exceção em código.
   */
  test("transacaoId é único, aceitando múltiplos NULL", () => {
    assert.match(pedido, /\n\s*transacaoId\s+String\?\s+@unique/);
    assert.ok(
      migracaoCodigo.includes('CREATE UNIQUE INDEX IF NOT EXISTS "PedidoPagamento_transacaoId_key"'),
    );
  });
});

describe("CHECKs: código e banco não podem divergir", () => {
  const emSql = (valores: readonly string[]) =>
    `IN (${valores.map((v) => `'${v}'`).join(", ")})`;

  test("o CHECK de status lista exatamente os estados de STATUS_PEDIDO", () => {
    assert.ok(
      migracaoCodigo.includes(emSql(STATUS_PEDIDO)),
      "o CHECK de status na migration não bate com STATUS_PEDIDO",
    );
  });

  /**
   * `simulado` está no código e **fora** do CHECK de Production, de propósito:
   * só o script do banco de teste o aceita. Assim um pedido simulado não grava
   * em Production nem com configuração errada.
   */
  test("o CHECK de provedor de Production é o código sem 'simulado'; o de teste é o código inteiro", async () => {
    const { readFileSync } = await import("node:fs");
    const deProducao = PROVEDORES_PAGAMENTO.filter((p) => p !== "simulado");
    assert.deepEqual(deProducao, ["blackcat"]);
    assert.ok(migracaoCodigo.includes(`CHECK ("provedor" ${emSql(deProducao)})`));
    const soTeste = readFileSync("scripts/ambiente-teste/03-provedor-simulado-somente-teste.sql", "utf8");
    assert.ok(soTeste.includes(`CHECK ("provedor" ${emSql(PROVEDORES_PAGAMENTO)})`));
  });

  /**
   * Cobrança de zero não é cobrança, e duração zero é uma assinatura que nasce
   * vencida. Mais estrito que o `>= 0` de `PlanoPreco.precoCentavos`, e de
   * propósito: um preço pode ser zero, um pedido não.
   */
  test("valor e duração têm CHECK de positivo estrito", () => {
    assert.ok(migracaoCodigo.includes('CHECK ("valorCentavos" > 0 AND "duracaoDias" > 0)'));
  });

  test("os três CHECK usam DROP IF EXISTS antes de ADD", () => {
    for (const nome of [
      "PedidoPagamento_status_check",
      "PedidoPagamento_provedor_check",
      "PedidoPagamento_valores_check",
    ]) {
      assert.ok(
        migracaoCodigo.includes(`DROP CONSTRAINT IF EXISTS "${nome}"`),
        `${nome} precisa tolerar reexecução, como as demais migrations daqui`,
      );
      assert.ok(migracaoCodigo.includes(`ADD CONSTRAINT "${nome}"`));
    }
  });

  /** `PAGO` precisa existir no domínio; ver o teste do serviço sobre não escrevê-lo. */
  test("PAGO está no domínio do banco, para a Fase 5 não precisar de migration", () => {
    assert.ok((STATUS_PEDIDO as readonly string[]).includes("PAGO"));
    assert.ok(migracaoCodigo.includes("'PAGO'"));
  });
});

describe("chaves estrangeiras", () => {
  const trecho = (constraint: string) => {
    const i = migracaoCodigo.indexOf(`ADD CONSTRAINT "${constraint}"`);
    assert.notEqual(i, -1, `${constraint} não é criada pela migration`);
    return migracaoCodigo.slice(i, migracaoCodigo.indexOf(";", i));
  };

  test("userId → User, CASCADE (conta apagada não deixa pedido órfão)", () => {
    const fk = trecho("PedidoPagamento_userId_fkey");
    assert.ok(fk.includes('REFERENCES "User"("id")'));
    assert.ok(fk.includes("ON DELETE CASCADE"));
  });

  test("planoId → Plano, RESTRICT", () => {
    const fk = trecho("PedidoPagamento_planoId_fkey");
    assert.ok(fk.includes('REFERENCES "Plano"("id")'));
    assert.ok(fk.includes("ON DELETE RESTRICT"));
  });

  /**
   * RESTRICT, e não SET NULL como em `Assinatura.planoPrecoId`: aqui a coluna é
   * NOT NULL. Apagar uma tabela de preços com pedidos apagaria a prova de quanto
   * foi cobrado.
   */
  test("planoPrecoId → PlanoPreco, RESTRICT (a coluna é NOT NULL)", () => {
    const fk = trecho("PedidoPagamento_planoPrecoId_fkey");
    assert.ok(fk.includes('REFERENCES "PlanoPreco"("id")'));
    assert.ok(fk.includes("ON DELETE RESTRICT"));
  });
});

describe("Assinatura.pedidoId passa a referenciar PedidoPagamento", () => {
  const assinatura = modelo("Assinatura");

  /**
   * Só a linha da relação com `PedidoPagamento`.
   *
   * `Assinatura` tem outras três relações, e a de `user` é legitimamente
   * `onDelete: Cascade` — apagar a conta leva a assinatura junto. Procurar
   * "Cascade" no modelo inteiro acusaria aquela, que está certa, e deixaria de
   * dizer qualquer coisa sobre esta, que é a que importa.
   */
  const relacaoDoPedido = (() => {
    const linha = assinatura
      .split("\n")
      .find((l) => /^\s*pedido\s+PedidoPagamento\?/.test(l));
    assert.ok(linha, "a relação `pedido` não existe em Assinatura");
    return linha;
  })();

  const fk = (() => {
    const i = migracaoCodigo.indexOf('ADD CONSTRAINT "Assinatura_pedidoId_fkey"');
    assert.notEqual(i, -1, "a FK de Assinatura.pedidoId não é criada");
    return migracaoCodigo.slice(i, migracaoCodigo.indexOf(";", i));
  })();

  test("a relação existe no schema", () => {
    assert.match(assinatura, /pedido\s+PedidoPagamento\?\s+@relation\(/);
    assert.ok(fk.includes('REFERENCES "PedidoPagamento"("id")'));
  });

  /**
   * O teste mais importante deste arquivo.
   *
   * `ON DELETE CASCADE` aqui significaria: apagar um pedido apaga a assinatura
   * que ele originou. Direito pago desaparecendo por causa de uma limpeza de
   * pedidos — e nada no comando de limpeza avisaria.
   */
  test("NUNCA é CASCADE", () => {
    assert.equal(
      fk.includes("ON DELETE CASCADE"),
      false,
      "apagar um pedido não pode apagar a assinatura que ele originou",
    );
    assert.equal(
      relacaoDoPedido.includes("onDelete: Cascade"),
      false,
      "a relação `pedido` não pode cascatear",
    );
  });

  /**
   * NO ACTION e não RESTRICT, e a diferença é técnica: `DELETE FROM "User"`
   * cascateia para `Assinatura` e para `PedidoPagamento`, e a ordem entre as
   * duas não é definida. RESTRICT recusa linha a linha e abortaria a exclusão da
   * conta quando o pedido saísse primeiro; NO ACTION verifica no fim do comando,
   * quando as duas linhas já saíram.
   */
  test("é NO ACTION, para a exclusão de conta continuar possível", () => {
    assert.ok(fk.includes("ON DELETE NO ACTION"));
    assert.match(relacaoDoPedido, /onDelete:\s*NoAction/);
  });

  test("continua opcional e única — um pedido ativa no máximo uma assinatura", () => {
    assert.match(assinatura, /pedidoId\s+String\?\s+@unique/);
  });

  /**
   * A coluna existe desde a Fase 1 sem FK, e produção pode ter linhas. Sem esta
   * verificação, o `ADD CONSTRAINT` falharia com uma mensagem genérica — ou, se
   * alguém "consertasse" limpando a coluna, apagaria em silêncio a origem de um
   * direito concedido.
   */
  test("a migration falha se houver pedidoId órfão, em vez de apagar dado", () => {
    assert.ok(migracaoCodigo.includes("RAISE EXCEPTION"), "precisa abortar, não corrigir");
    assert.ok(migracaoCodigo.includes('NOT EXISTS'));

    const guarda = migracaoCodigo.indexOf("RAISE EXCEPTION");
    const criacaoDaFk = migracaoCodigo.indexOf('ADD CONSTRAINT "Assinatura_pedidoId_fkey"');
    assert.ok(guarda < criacaoDaFk, "a verificação precisa vir ANTES da FK");

    for (const destrutivo of ["DELETE FROM", "UPDATE \"Assinatura\" SET", "TRUNCATE"]) {
      assert.equal(
        migracaoCodigo.includes(destrutivo),
        false,
        `a migration não pode conter ${destrutivo} — dado órfão é decisão humana`,
      );
    }
  });
});

describe("índices de consulta", () => {
  const pedido = modelo("PedidoPagamento");

  test("userId/status/criadoEm — os pedidos de uma conta", () => {
    assert.match(pedido, /@@index\(\[userId, status, criadoEm\]\)/);
    assert.ok(migracaoCodigo.includes('"PedidoPagamento_userId_status_criadoEm_idx"'));
  });

  test("status/expiraEm — a varredura da reconciliação da Fase 5", () => {
    assert.match(pedido, /@@index\(\[status, expiraEm\]\)/);
    assert.ok(migracaoCodigo.includes('"PedidoPagamento_status_expiraEm_idx"'));
  });
});

describe("Row Level Security", () => {
  test("RLS ligado na tabela", () => {
    assert.ok(migracaoCodigo.includes('ALTER TABLE "PedidoPagamento" ENABLE ROW LEVEL SECURITY'));
  });

  /**
   * Sem policy e com RLS ligado, ninguém lê nada por PostgREST. O Prisma conecta
   * como dono e passa por cima, que é o desenho. Uma policy criada por descuido
   * abriria a tabela de cobrança para a Data API do Supabase.
   */
  test("nenhuma policy, e nenhum GRANT para anon/authenticated", () => {
    assert.equal(migracaoCodigo.includes("CREATE POLICY"), false);
    assert.equal(/\bGRANT\b/.test(migracaoCodigo), false);
    assert.equal(/\banon\b|\bauthenticated\b/.test(migracaoCodigo), false);
  });
});

describe("a migration não cria nem ativa nada", () => {
  /**
   * A promessa central da fase, escrita como teste: **nenhuma assinatura**.
   */
  test("nenhum INSERT em lugar nenhum", () => {
    assert.equal(
      /\bINSERT\s+INTO\b/i.test(migracaoCodigo),
      false,
      "esta migration cria estrutura, nunca linha",
    );
  });

  test("a migration não menciona ativar assinatura", () => {
    // O SQL fala de "Assinatura" só para a FK e para a verificação de órfãos.
    // Qualquer escrita nela seria concessão de direito por migration.
    assert.equal(/\bINSERT\s+INTO\s+"Assinatura"/i.test(migracaoCodigo), false);
    assert.equal(/\bUPDATE\s+"Assinatura"\s+SET/i.test(migracaoCodigo), false);
  });

  test("abre e fecha a própria transação", () => {
    assert.ok(migracao.trimStart().startsWith("--"));
    assert.ok(migracaoCodigo.includes("\nBEGIN;"));
    assert.ok(migracao.trimEnd().endsWith("COMMIT;"));
    assert.equal(
      migracaoCodigo.includes("CONCURRENTLY"),
      false,
      "CREATE INDEX CONCURRENTLY não roda em transação e teria de sair deste arquivo",
    );
  });
});

describe("ROLLBACK protege o que não pode ser apagado em silêncio", () => {
  test("recusa sozinho quando há pedido ou assinatura ligada", () => {
    assert.ok(rollbackCodigo.includes("RAISE EXCEPTION"));
    assert.ok(rollbackCodigo.includes('FROM "PedidoPagamento"'));
    assert.ok(rollbackCodigo.includes('WHERE "pedidoId" IS NOT NULL'));
  });

  /**
   * `DROP TABLE ... CASCADE` derrubaria a constraint e deixaria
   * `Assinatura.pedidoId` órfã em silêncio. A FK sai num comando que dá para
   * ler, antes.
   */
  test("derruba a FK explicitamente, e nunca com CASCADE", () => {
    assert.ok(rollbackCodigo.includes('ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_pedidoId_fkey"'));
    assert.equal(/DROP TABLE[^;]*CASCADE/i.test(rollbackCodigo), false);

    const dropFk = rollbackCodigo.indexOf('DROP CONSTRAINT IF EXISTS "Assinatura_pedidoId_fkey"');
    const dropTabela = rollbackCodigo.indexOf('DROP TABLE IF EXISTS "PedidoPagamento"');
    assert.ok(dropFk < dropTabela, "a FK precisa sair antes da tabela");
  });

  test("não desfaz a Fase 1 — a coluna pedidoId permanece", () => {
    assert.equal(
      /ALTER TABLE "Assinatura" DROP COLUMN/i.test(rollbackCodigo),
      false,
      "a coluna nasceu na Fase 1; desfazer a Fase 4 não desfaz a Fase 1",
    );
  });
});
