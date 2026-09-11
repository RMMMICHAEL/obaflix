import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  APLICACAO_DOS_DIREITOS,
  direitosAplicados,
  direitosNaoAplicados,
} from "../direitosAplicados";
import { PLANO_GRATUITO } from "../planos";
import type { DireitosDoPlano } from "../planos";

/**
 * O registro do que é aplicado, testado para não envelhecer.
 *
 * O valor deste arquivo não está em conferir que `resolucaoMax` não é aplicado
 * hoje — isso é uma linha de documentação. Está em tornar **impossível** que a
 * classificação e a realidade divirjam em silêncio: direito novo sem
 * classificação quebra, entrada órfã quebra, e `aplicado` apontando para um
 * arquivo que não menciona o campo quebra.
 */

const raiz = process.cwd();

/** As chaves reais de `DireitosDoPlano`, tiradas de um plano concreto. */
const CAMPOS_DE_DIREITO = Object.keys(PLANO_GRATUITO).filter(
  (k) => !["id", "nome", "descricao", "ordem", "ativo", "ehPadrao"].includes(k),
) as (keyof DireitosDoPlano)[];

describe("o registro cobre exatamente os direitos que existem", () => {
  test("nenhum direito ficou sem classificação", () => {
    for (const campo of CAMPOS_DE_DIREITO) {
      assert.ok(
        APLICACAO_DOS_DIREITOS[campo],
        `${campo} entrou em DireitosDoPlano e ninguém disse se é aplicado`,
      );
    }
  });

  test("nenhuma entrada órfã", () => {
    for (const campo of Object.keys(APLICACAO_DOS_DIREITOS)) {
      assert.ok(
        (CAMPOS_DE_DIREITO as string[]).includes(campo),
        `${campo} está no registro e não é mais um direito`,
      );
    }
  });

  test("aplicados e não aplicados particionam o conjunto", () => {
    const soma = [...direitosAplicados(), ...direitosNaoAplicados()].sort();
    assert.deepEqual(soma, [...CAMPOS_DE_DIREITO].sort());
    assert.equal(new Set(soma).size, soma.length, "nenhum direito nos dois grupos");
  });
});

/**
 * O teste que dá dentes ao registro.
 *
 * Sem ele, promover um direito a "aplicado" seria editar uma string. Com ele, o
 * arquivo apontado precisa de fato mencionar o campo — o que não prova que a
 * aplicação está correta, mas prova que ela existe em algum lugar concreto e que
 * o ponteiro não apodreceu.
 */
describe("`aplicado` aponta para código que existe e cita o campo", () => {
  for (const campo of direitosAplicados()) {
    test(`${campo}: o arquivo indicado menciona o campo`, () => {
      const { onde } = APLICACAO_DOS_DIREITOS[campo];
      assert.notEqual(onde, "", `${campo} está aplicado e não diz onde`);

      const fonte = readFileSync(join(raiz, onde), "utf8");
      assert.ok(
        fonte.includes(campo),
        `${onde} não menciona ${campo} — o ponteiro do registro está errado`,
      );
    });
  }

  test("`nao_aplicado` não aponta para lugar nenhum", () => {
    for (const campo of direitosNaoAplicados()) {
      assert.equal(
        APLICACAO_DOS_DIREITOS[campo].onde,
        "",
        `${campo} é não-aplicado e tem um "onde" preenchido — contradição`,
      );
    }
  });

  test("toda entrada explica o que falta ou o que faz", () => {
    for (const campo of CAMPOS_DE_DIREITO) {
      assert.ok(
        APLICACAO_DOS_DIREITOS[campo].nota.length > 20,
        `${campo} precisa de uma nota útil`,
      );
    }
  });
});

/**
 * O estado desta entrega, escrito por extenso.
 *
 * Não é redundante com os testes acima: eles garantem coerência interna, este
 * garante que a coerência é com a realidade **combinada**. Se alguém aplicar
 * `resolucaoMax` de verdade, este teste falha e obriga a atualizar o registro —
 * que é exatamente o momento de atualizar a documentação também.
 */
describe("o que esta entrega aplica, e o que deixou marcado", () => {
  test("telasMax e downloads passaram a ser aplicados", () => {
    assert.equal(APLICACAO_DOS_DIREITOS.telasMax.estado, "aplicado");
    assert.equal(APLICACAO_DOS_DIREITOS.downloads.estado, "aplicado");
  });

  test("filmes e series continuam aplicados", () => {
    assert.equal(APLICACAO_DOS_DIREITOS.filmes.estado, "aplicado");
    assert.equal(APLICACAO_DOS_DIREITOS.series.estado, "aplicado");
  });

  /** O pedido explícito: ou têm consumidor real, ou ficam claramente marcados. */
  test("resolucaoMax e tvNivel estão marcados como NÃO aplicados", () => {
    assert.equal(APLICACAO_DOS_DIREITOS.resolucaoMax.estado, "nao_aplicado");
    assert.equal(APLICACAO_DOS_DIREITOS.tvNivel.estado, "nao_aplicado");
  });

  /**
   * `canaisNivel` era o caso sutil: a camada existia, escrita, mas fora de
   * `main` — o direito era gravado e ninguém lia. Com a integração da branch de
   * canais ela passou a existir aqui, e o registro acompanha.
   *
   * O teste de ponteiro acima é o que sustenta a promoção: `onde` precisa
   * apontar para um arquivo que mencione o campo, então marcar `aplicado` sem
   * enforcement de verdade falharia.
   */
  test("canaisNivel passou a ser aplicado pela camada de canais", () => {
    assert.equal(APLICACAO_DOS_DIREITOS.canaisNivel.estado, "aplicado");
    assert.equal(APLICACAO_DOS_DIREITOS.canaisNivel.onde, "src/lib/canais/acesso.ts");
  });

  /**
   * A diferença que separa `canaisNivel` dos outros aplicados, e que vale estar
   * travada: ele **não** passa por `MONETIZACAO_ATIVA`.
   *
   * Canais nasceram monetizados — nunca houve um estado de "todo mundo tinha
   * canal" a preservar, que é a razão de a flag existir para os demais. Quem
   * ligar a flag um dia não deve descobrir por acidente que canais já valia.
   */
  test("a nota registra que canais não passa pela flag", () => {
    assert.match(APLICACAO_DOS_DIREITOS.canaisNivel.nota, /MONETIZACAO_ATIVA/);
  });

  test("a nota de downloads diz que não é fronteira criptográfica", () => {
    // Impede que a limitação honesta suma numa edição futura do texto.
    assert.match(APLICACAO_DOS_DIREITOS.downloads.nota, /cliente|CDN/i);
  });
});
