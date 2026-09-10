import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PLANO_GRATUITO,
  TELAS_SIMULTANEAS_HOJE,
  CANAIS_NIVEIS,
  RESOLUCOES,
  TV_NIVEIS,
  STATUS_ASSINATURA,
  ORIGENS_ASSINATURA,
  dadosDoUpsert,
} from "../planos";

/**
 * Fase 1 não tem lógica de runtime para exercitar — ela cria tabelas e uma
 * linha. O que dá para testar, e é o que importa, são as duas promessas que a
 * fase fez:
 *
 *   1. o seed reproduz o comportamento de hoje, campo a campo;
 *   2. o que o código escreve é o que o banco aceita.
 *
 * A segunda existe porque o domínio dos campos de texto vive em dois lugares —
 * as constantes de `planos.ts` e os CHECK da migration. Dois lugares divergem;
 * um teste que lê os dois arquivos não deixa.
 */

// `npm test` roda da raiz do pacote. Ler o arquivo é o que permite comparar o
// código com o SQL sem duplicar nenhum dos dois num terceiro lugar.
const raiz = process.cwd();
const migracao = readFileSync(
  join(raiz, "prisma/migrations/20260910_planos_assinaturas/migration.sql"),
  "utf8",
);

describe("plano padrão: fotografia do comportamento atual", () => {
  test("é o plano padrão, e está ativo", () => {
    assert.equal(PLANO_GRATUITO.id, "gratuito");
    assert.equal(PLANO_GRATUITO.ehPadrao, true);
    assert.equal(PLANO_GRATUITO.ativo, true);
  });

  test("não exige anúncio — hoje ninguém vê anúncio", () => {
    assert.equal(PLANO_GRATUITO.anunciosObrigatorios, false);
    assert.equal(PLANO_GRATUITO.episodiosPorAnuncio, null);
  });

  test("libera filmes, séries e downloads — como hoje", () => {
    assert.equal(PLANO_GRATUITO.filmes, true);
    assert.equal(PLANO_GRATUITO.series, true);
    assert.equal(PLANO_GRATUITO.downloads, true);
  });

  test("não limita resolução nem TV — como hoje", () => {
    assert.equal(PLANO_GRATUITO.resolucaoMax, "4k");
    assert.equal(PLANO_GRATUITO.tvNivel, "completo");
  });

  test("canais em 'nenhum': o produto ainda não os tem, então não tira nada", () => {
    assert.equal(PLANO_GRATUITO.canaisNivel, "nenhum");
  });

  test("perfis em 1: não existem no schema", () => {
    assert.equal(PLANO_GRATUITO.perfisMax, 1);
  });

  /**
   * O teste que trava a regressão mais cara desta fase.
   *
   * `telasMax` é o campo que vai substituir `MAX_CONCURRENT` quando a
   * autorização for ligada. Semeado abaixo do valor real, toda conta perderia
   * streams simultâneos de uma vez — e o sintoma ("parou de tocar na segunda
   * tela") não apontaria para um seed escrito fases antes.
   *
   * Lê o valor direto de `playTokens.ts` em vez de repetir o número: aquele
   * arquivo não exporta a constante, e exportá-la seria tocar num arquivo que
   * esta fase não pode alterar.
   */
  test("telasMax acompanha o MAX_CONCURRENT real de playTokens.ts", () => {
    const fonte = readFileSync(join(raiz, "src/lib/playTokens.ts"), "utf8");
    const achado = fonte.match(/const\s+MAX_CONCURRENT\s*=\s*(\d+)/);

    assert.ok(
      achado,
      "MAX_CONCURRENT não foi encontrado em playTokens.ts — se ele mudou de " +
        "nome ou de forma, esta comparação precisa acompanhar em vez de sumir",
    );

    const real = Number(achado[1]);
    assert.equal(
      TELAS_SIMULTANEAS_HOJE,
      real,
      "TELAS_SIMULTANEAS_HOJE saiu de sincronia com MAX_CONCURRENT",
    );
    assert.equal(
      PLANO_GRATUITO.telasMax,
      real,
      "o plano padrão daria ao usuário menos (ou mais) telas do que ele tem hoje",
    );
  });
});

describe("domínio: código e banco não podem divergir", () => {
  test("todo valor do seed pertence ao domínio declarado", () => {
    assert.ok((CANAIS_NIVEIS as readonly string[]).includes(PLANO_GRATUITO.canaisNivel));
    assert.ok((RESOLUCOES as readonly string[]).includes(PLANO_GRATUITO.resolucaoMax));
    assert.ok((TV_NIVEIS as readonly string[]).includes(PLANO_GRATUITO.tvNivel));
  });

  test("os CHECK da migration listam exatamente os mesmos valores", () => {
    const emSql = (valores: readonly string[]) =>
      `IN (${valores.map((v) => `'${v}'`).join(", ")})`;

    for (const [nome, valores] of [
      ["canaisNivel", CANAIS_NIVEIS],
      ["resolucaoMax", RESOLUCOES],
      ["tvNivel", TV_NIVEIS],
      ["status", STATUS_ASSINATURA],
      ["origem", ORIGENS_ASSINATURA],
    ] as const) {
      assert.ok(
        migracao.includes(emSql(valores)),
        `o CHECK de ${nome} na migration não bate com a constante de planos.ts`,
      );
    }
  });

  test("números do seed respeitam os CHECK de limite", () => {
    assert.ok(PLANO_GRATUITO.telasMax >= 1);
    assert.ok(PLANO_GRATUITO.perfisMax >= 1);
    assert.ok(PLANO_GRATUITO.janelaAnuncioHoras >= 1);
    assert.ok(
      PLANO_GRATUITO.episodiosPorAnuncio === null ||
        PLANO_GRATUITO.episodiosPorAnuncio >= 1,
    );
  });
});

describe("seed idempotente", () => {
  /** Repositório mínimo com a semântica de upsert do Prisma. */
  function repositorioFalso() {
    const linhas = new Map<string, Record<string, unknown>>();
    return {
      linhas,
      upsert(dados: ReturnType<typeof dadosDoUpsert>) {
        const existente = linhas.get(dados.where.id);
        if (existente) linhas.set(dados.where.id, { ...existente, ...dados.update });
        else linhas.set(dados.where.id, { ...dados.create });
      },
    };
  }

  test("rodar duas vezes deixa uma linha, idêntica", () => {
    const repo = repositorioFalso();
    repo.upsert(dadosDoUpsert(PLANO_GRATUITO));
    const depoisDaPrimeira = { ...repo.linhas.get("gratuito") };

    repo.upsert(dadosDoUpsert(PLANO_GRATUITO));

    assert.equal(repo.linhas.size, 1);
    assert.deepEqual(repo.linhas.get("gratuito"), depoisDaPrimeira);
  });

  test("o update conserta coluna editada à mão", () => {
    // O erro clássico de seed: `update` cobrindo menos campos que `create`. A
    // linha nasce certa, alguém mexe numa coluna, o seed roda de novo e não
    // conserta — e a diferença só aparece quando aquele campo passa a decidir
    // alguma coisa.
    const repo = repositorioFalso();
    repo.upsert(dadosDoUpsert(PLANO_GRATUITO));

    repo.linhas.set("gratuito", {
      ...repo.linhas.get("gratuito")!,
      telasMax: 1,
      anunciosObrigatorios: true,
    });

    repo.upsert(dadosDoUpsert(PLANO_GRATUITO));

    const linha = repo.linhas.get("gratuito")!;
    assert.equal(linha.telasMax, PLANO_GRATUITO.telasMax);
    assert.equal(linha.anunciosObrigatorios, false);
  });

  test("o upsert cobre todo campo do plano, menos o id", () => {
    const dados = dadosDoUpsert(PLANO_GRATUITO);
    const noCreate = Object.keys(dados.create).sort();
    const noUpdate = Object.keys(dados.update).sort();

    assert.deepEqual(noCreate, Object.keys(PLANO_GRATUITO).sort());
    assert.deepEqual(noUpdate, noCreate.filter((c) => c !== "id"));
  });
});
