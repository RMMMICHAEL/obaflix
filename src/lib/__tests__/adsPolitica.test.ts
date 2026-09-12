import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  EPISODIOS_POR_ANUNCIO_PADRAO,
  JANELA_ANUNCIO_HORAS_PADRAO,
  decidirAnuncio,
  episodiosPorAnuncio,
  exigeAnuncio,
  janelaAnuncioHoras,
} from "../ads/politica";
import { PLANO_BASIC, PLANO_GRATUITO, PLANO_PLUS, PLANO_PREMIUM } from "../planos";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * A regra de anúncio, exercitada como regra pura.
 *
 * O que estes testes travam:
 *
 *   1. **plano pago nunca entra no fluxo publicitário** — e não por nome de
 *      plano, mas porque `anunciosObrigatorios` é `false` neles;
 *   2. **a cadência de séries** — 1 livre, 2 livre, 3 anúncio, com `N` vindo do
 *      plano;
 *   3. **fail-closed** — direito ausente ou contador desconhecido não viram
 *      "assiste de graça".
 */

/** Os direitos de um plano semeado, sem os campos comerciais. */
function direitosDe(plano: PlanoSemeado): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return direitos as DireitosDoPlano;
}

const GRATUITO = direitosDe(PLANO_GRATUITO);

// ── 1. Planos pagos nunca veem anúncio ───────────────────────────────────────

describe("planos pagos nunca entram no fluxo publicitário", () => {
  /**
   * O cenário 1 da lista, e o mais caro de quebrar: um assinante que recebe
   * ANUNCIO_NECESSARIO é um assinante que pediu reembolso.
   */
  for (const plano of [PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM]) {
    test(`${plano.id}: filme e série sempre permitidos`, () => {
      const direitos = direitosDe(plano);
      assert.equal(exigeAnuncio(direitos), false);

      for (const tipo of ["filme", "serie"] as const) {
        const r = decidirAnuncio({ direitos, tipo, temConcessao: false });
        assert.equal(r.decisao, "permitido", `${plano.id}/${tipo}`);
        assert.equal(r.decisao === "permitido" && r.via, "sem_anuncios");
      }
    });
  }

  /**
   * Mesmo com o contador "estourado", o assinante passa. A saída acontece no
   * primeiro `if`, antes de qualquer contagem — é o que garante que ele não
   * paga nem por uma consulta do fluxo de anúncio.
   */
  test("contador alto não afeta quem não tem anúncio obrigatório", () => {
    const r = decidirAnuncio({
      direitos: direitosDe(PLANO_PREMIUM),
      tipo: "serie",
      temConcessao: false,
      episodiosDistintosNaJanela: 99,
    });
    assert.equal(r.decisao === "permitido" && r.via, "sem_anuncios");
  });

  /**
   * Cenário 13: a decisão vem do direito resolvido, nunca da identidade. Um
   * plano com nome "Premium" mas `anunciosObrigatorios: true` VÊ anúncio, e um
   * chamado "Gratuito" com `false` não vê. Se alguém trocar a regra por
   * comparação de nome, isto quebra.
   */
  test("o nome do plano não decide — só o direito", () => {
    const premiumComAnuncio = { ...direitosDe(PLANO_PREMIUM), anunciosObrigatorios: true };
    const gratuitoSemAnuncio = { ...GRATUITO, anunciosObrigatorios: false };

    assert.equal(
      decidirAnuncio({ direitos: premiumComAnuncio, tipo: "filme", temConcessao: false }).decisao,
      "anuncio_necessario",
    );
    assert.equal(
      decidirAnuncio({ direitos: gratuitoSemAnuncio, tipo: "filme", temConcessao: false }).decisao,
      "permitido",
    );
  });

  /** Direito ausente não liga anúncio por coerção — falha do lado de quem paga. */
  test("anunciosObrigatorios undefined não vira true", () => {
    const semCampo = { ...GRATUITO, anunciosObrigatorios: undefined as unknown as boolean };
    assert.equal(exigeAnuncio(semCampo), false);
    assert.equal(decidirAnuncio({ direitos: semCampo, tipo: "filme", temConcessao: false }).decisao, "permitido");
  });
});

// ── 2/3. Filme ───────────────────────────────────────────────────────────────

describe("filme", () => {
  /** Cenário 2. */
  test("gratuito sem concessão exige anúncio", () => {
    const r = decidirAnuncio({ direitos: GRATUITO, tipo: "filme", temConcessao: false });
    assert.equal(r.decisao, "anuncio_necessario");
  });

  /** Cenário 3. A concessão é a prova de que o anúncio já aconteceu. */
  test("gratuito com concessão válida é permitido", () => {
    const r = decidirAnuncio({ direitos: GRATUITO, tipo: "filme", temConcessao: true });
    assert.equal(r.decisao, "permitido");
    assert.equal(r.decisao === "permitido" && r.via, "concessao");
  });
});

// ── 7/8/9. Séries ───────────────────────────────────────────────────────────

describe("séries: 1 livre, 2 livre, 3 anúncio", () => {
  const comN = (n: number): DireitosDoPlano => ({ ...GRATUITO, episodiosPorAnuncio: n });

  /** Cenários 7, 8 e 9, na sequência exata que foi aprovada. */
  test("com N=3, o terceiro episódio distinto paga", () => {
    const esperado = [
      [1, "permitido"],
      [2, "permitido"],
      [3, "anuncio_necessario"],
    ] as const;

    for (const [distintos, decisao] of esperado) {
      const r = decidirAnuncio({
        direitos: comN(3), tipo: "serie", temConcessao: false,
        episodiosDistintosNaJanela: distintos,
      });
      assert.equal(r.decisao, decisao, `episódio distinto ${distintos}`);
    }
  });

  /** A cadência continua depois do primeiro ciclo, sem precisar zerar nada. */
  test("a cadência se mantém: 6 e 9 também pagam", () => {
    for (const distintos of [4, 5, 7, 8]) {
      assert.equal(
        decidirAnuncio({ direitos: comN(3), tipo: "serie", temConcessao: false, episodiosDistintosNaJanela: distintos }).decisao,
        "permitido",
        `${distintos} deveria passar`,
      );
    }
    for (const distintos of [6, 9, 12]) {
      assert.equal(
        decidirAnuncio({ direitos: comN(3), tipo: "serie", temConcessao: false, episodiosDistintosNaJanela: distintos }).decisao,
        "anuncio_necessario",
        `${distintos} deveria pagar`,
      );
    }
  });

  /** O `N` é configurável pelo plano — requisito explícito. */
  test("N vem do plano: com N=2 o segundo paga", () => {
    assert.equal(
      decidirAnuncio({ direitos: comN(2), tipo: "serie", temConcessao: false, episodiosDistintosNaJanela: 1 }).decisao,
      "permitido",
    );
    assert.equal(
      decidirAnuncio({ direitos: comN(2), tipo: "serie", temConcessao: false, episodiosDistintosNaJanela: 2 }).decisao,
      "anuncio_necessario",
    );
  });

  test("concessão válida libera mesmo no episódio que pagaria", () => {
    const r = decidirAnuncio({
      direitos: comN(3), tipo: "serie", temConcessao: true, episodiosDistintosNaJanela: 3,
    });
    assert.equal(r.decisao === "permitido" && r.via, "concessao");
  });

  /**
   * Fail-closed: não saber quantos episódios foram vistos não pode virar acesso
   * livre. Pedir anúncio é o lado barato do erro — o usuário vê um anúncio, e
   * ninguém fica travado.
   */
  test("contador desconhecido ou inválido pede anúncio", () => {
    for (const distintos of [undefined, 0, -1, 1.5, NaN]) {
      const r = decidirAnuncio({
        direitos: comN(3), tipo: "serie", temConcessao: false,
        episodiosDistintosNaJanela: distintos as number | undefined,
      });
      assert.equal(r.decisao, "anuncio_necessario", `distintos=${distintos}`);
    }
  });
});

// ── Configuração ─────────────────────────────────────────────────────────────

describe("episodiosPorAnuncio e janelaAnuncioHoras vêm do plano", () => {
  test("valores válidos são respeitados", () => {
    assert.equal(episodiosPorAnuncio({ ...GRATUITO, episodiosPorAnuncio: 5 }), 5);
    assert.equal(janelaAnuncioHoras({ ...GRATUITO, janelaAnuncioHoras: 48 }), 48);
  });

  /**
   * O CHECK do banco já recusa `< 1`; chegar aqui fora do domínio significa que
   * algo passou por fora dele. Cair no default é mais defensável do que dividir
   * por zero ou por nulo.
   */
  test("valores fora do domínio caem no padrão aprovado", () => {
    for (const n of [null, 0, -1, 2.5, NaN, "3" as unknown as number]) {
      assert.equal(
        episodiosPorAnuncio({ ...GRATUITO, episodiosPorAnuncio: n as number | null }),
        EPISODIOS_POR_ANUNCIO_PADRAO,
        `N=${n}`,
      );
    }
    for (const h of [0, -1, 1.5, NaN]) {
      assert.equal(janelaAnuncioHoras({ ...GRATUITO, janelaAnuncioHoras: h }), JANELA_ANUNCIO_HORAS_PADRAO);
    }
  });

  test("os padrões são os aprovados: 3 episódios, 24 horas", () => {
    assert.equal(EPISODIOS_POR_ANUNCIO_PADRAO, 3);
    assert.equal(JANELA_ANUNCIO_HORAS_PADRAO, 24);
  });

  /**
   * O plano gratuito semeado exige anúncio — é o que faz toda esta regra ter
   * consequência. Se alguém desligar isso sem decisão comercial, o fluxo
   * publicitário inteiro vira código morto em silêncio.
   */
  test("o plano gratuito da matriz exige anúncio", () => {
    assert.equal(PLANO_GRATUITO.anunciosObrigatorios, true);
    assert.equal(exigeAnuncio(GRATUITO), true);
  });
});
