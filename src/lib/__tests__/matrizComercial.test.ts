import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CANAIS_NIVEIS,
  PLANOS_COMERCIAIS,
  PLANO_BASIC,
  PLANO_GRATUITO,
  PLANO_PLUS,
  PLANO_PREMIUM,
  RESOLUCOES,
  TV_NIVEIS,
  inversoesDeDireito,
  semearPlano,
  semearPlanosComerciais,
  type PlanoSemeado,
  type RepositorioDePlanos,
} from "../planos";

/**
 * A matriz comercial — Basic, Plus, Premium.
 *
 * O que estes testes travam, e por que cada um importa:
 *
 *   1. **o mapeamento exato de entitlement**, campo a campo. É a definição do
 *      produto; uma alteração acidental aqui vende outra coisa;
 *   2. **a escada de canais**, que é o único direito desta matriz efetivamente
 *      aplicado pelo backend hoje;
 *   3. **nenhum preço**, porque plano sem preço é plano não comprável — e é
 *      esse o estado pedido enquanto os valores comerciais não chegam;
 *   4. **`gratuito` intocado**, incluindo continuar sendo o único `ehPadrao`.
 */

const raiz = process.cwd();

// ── 1. O mapeamento ──────────────────────────────────────────────────────────

describe("mapeamento de entitlement, campo a campo", () => {
  /**
   * Escrito como tabela literal de propósito, e não derivado das constantes:
   * um teste que recalcula o valor a partir da mesma fonte que testa não prova
   * nada. Estes números são os que foram aprovados comercialmente.
   */
  const esperado: Record<string, Partial<PlanoSemeado>> = {
    basic: {
      telasMax: 2,
      filmes: true,
      series: true,
      anunciosObrigatorios: false,
      downloads: false,
      canaisNivel: "nenhum",
    },
    plus: {
      telasMax: 2,
      filmes: true,
      series: true,
      anunciosObrigatorios: false,
      downloads: true,
      canaisNivel: "plus",
    },
    premium: {
      telasMax: 2,
      filmes: true,
      series: true,
      anunciosObrigatorios: false,
      downloads: true,
      canaisNivel: "premium",
    },
  };

  for (const plano of PLANOS_COMERCIAIS) {
    test(`${plano.id}: os seis direitos da matriz`, () => {
      for (const [campo, valor] of Object.entries(esperado[plano.id])) {
        assert.equal(
          plano[campo as keyof PlanoSemeado],
          valor,
          `${plano.id}.${campo} saiu da matriz aprovada`,
        );
      }
    });
  }

  test("os três ids são exatamente basic, plus e premium", () => {
    assert.deepEqual(PLANOS_COMERCIAIS.map((p) => p.id), ["basic", "plus", "premium"]);
  });

  test("as três são vendáveis na vitrine e ordenadas", () => {
    assert.deepEqual(PLANOS_COMERCIAIS.map((p) => p.ordem), [1, 2, 3]);
    for (const p of PLANOS_COMERCIAIS) assert.equal(p.ativo, true);
  });

  /** Decisões tomadas fora da matriz escrita. Ficam travadas para não derivarem. */
  test("qualidade: basic e plus em hd, premium em 4k", () => {
    assert.equal(PLANO_BASIC.resolucaoMax, "hd");
    assert.equal(PLANO_PLUS.resolucaoMax, "hd");
    assert.equal(PLANO_PREMIUM.resolucaoMax, "4k");
  });

  test("TV integral nos três planos pagos", () => {
    for (const p of PLANOS_COMERCIAIS) assert.equal(p.tvNivel, "completo");
  });

  /**
   * Sem anúncio, não há o que contar. `episodiosPorAnuncio` em `null` é o que
   * mantém coerente o par com `anunciosObrigatorios: false` — um número ali
   * sugeriria uma regra de anúncio que nenhum destes planos tem.
   */
  test("sem anúncio em nenhum dos três, e sem contador pendurado", () => {
    for (const p of PLANOS_COMERCIAIS) {
      assert.equal(p.anunciosObrigatorios, false);
      assert.equal(p.episodiosPorAnuncio, null);
    }
  });

  /** D-5: perfis são projeto próprio. O campo segue reservado. */
  test("perfisMax continua 1 — perfis não existem no schema", () => {
    for (const p of PLANOS_COMERCIAIS) assert.equal(p.perfisMax, 1);
  });
});

// ── 2. A escada de canais ────────────────────────────────────────────────────

describe("canais: a escada, e o que cada plano alcança", () => {
  /**
   * Reprodução local da regra de `src/lib/canais/acesso.ts`.
   *
   * Reproduzida, e não importada, porque aquele módulo vive na branch de canais
   * e ainda não está em `main` — este arquivo precisa rodar aqui. As duas partes
   * que importam estão preservadas: a negação explícita de `"nenhum"` antes de
   * qualquer comparação, e a comparação por índice depois dela.
   *
   * O teste seguinte trava a duplicação: se a escala mudar em `planos.ts`, isto
   * quebra junto.
   */
  const alcanca = (daConta: string, doCanal: string): boolean => {
    if (daConta === "nenhum") return false;
    return CANAIS_NIVEIS.indexOf(daConta as never) >= CANAIS_NIVEIS.indexOf(doCanal as never);
  };

  test("a escala é nenhum < gratuito < plus < premium", () => {
    assert.deepEqual([...CANAIS_NIVEIS], ["nenhum", "gratuito", "plus", "premium"]);
  });

  /**
   * O caso que a matriz trata de forma contraintuitiva, e de propósito: Basic é
   * um plano PAGO cujo nível de canais é `"nenhum"`. Não é "o canal mais
   * barato" — é canal nenhum, nem os marcados gratuito.
   */
  test("basic não alcança canal nenhum, nem o gratuito", () => {
    for (const doCanal of ["gratuito", "plus", "premium"]) {
      assert.equal(
        alcanca(PLANO_BASIC.canaisNivel, doCanal),
        false,
        `basic não pode alcançar canal ${doCanal}`,
      );
    }
  });

  test("plus alcança gratuito e plus, e NÃO alcança premium", () => {
    assert.equal(alcanca(PLANO_PLUS.canaisNivel, "gratuito"), true);
    assert.equal(alcanca(PLANO_PLUS.canaisNivel, "plus"), true);
    assert.equal(
      alcanca(PLANO_PLUS.canaisNivel, "premium"),
      false,
      "plus assistindo canal premium é a regressão comercial mais cara desta matriz",
    );
  });

  test("premium alcança os três níveis — catálogo completo", () => {
    for (const doCanal of ["gratuito", "plus", "premium"]) {
      assert.equal(alcanca(PLANO_PREMIUM.canaisNivel, doCanal), true);
    }
  });

  /**
   * "Catálogo completo" é um nível, não um número. Fixar "2.000 canais" criaria
   * uma promessa que o banco não sustenta — quantos canais existem é
   * consequência da curadoria e do import.
   */
  test("nenhuma contagem de canais vira constante", () => {
    const fonte = readFileSync(join(raiz, "src/lib/planos.ts"), "utf8");
    const codigo = fonte
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");
    assert.equal(/\b2000\b|\b2\.000\b|canaisCount|totalDeCanais/.test(codigo), false);
  });
});

// ── 3. Domínios e preço ──────────────────────────────────────────────────────

describe("os valores pertencem aos domínios que o banco aceita", () => {
  test("canaisNivel, resolucaoMax e tvNivel estão no domínio", () => {
    for (const p of PLANOS_COMERCIAIS) {
      assert.ok((CANAIS_NIVEIS as readonly string[]).includes(p.canaisNivel), `${p.id}.canaisNivel`);
      assert.ok((RESOLUCOES as readonly string[]).includes(p.resolucaoMax), `${p.id}.resolucaoMax`);
      assert.ok((TV_NIVEIS as readonly string[]).includes(p.tvNivel), `${p.id}.tvNivel`);
    }
  });

  /** Os CHECK de limite da migration 20260910_planos_assinaturas. */
  test("os números respeitam os CHECK de limite", () => {
    for (const p of PLANOS_COMERCIAIS) {
      assert.ok(p.telasMax >= 1, `${p.id}.telasMax`);
      assert.ok(p.perfisMax >= 1, `${p.id}.perfisMax`);
      assert.ok(p.janelaAnuncioHoras >= 1, `${p.id}.janelaAnuncioHoras`);
      assert.ok(p.episodiosPorAnuncio === null || p.episodiosPorAnuncio >= 1, `${p.id}`);
    }
  });

  /**
   * Plano sem preço é plano não comprável: `resolverPreco` recusa com
   * `preco_inexistente` antes de tocar o provedor. É o estado pedido enquanto os
   * valores comerciais não chegam, e este teste existe para que preço fictício
   * não entre "só para destravar o checkout".
   */
  test("nem o módulo nem o seed criam PlanoPreco", () => {
    for (const arquivo of ["src/lib/planos.ts", "scripts/seed-planos.ts"]) {
      const fonte = readFileSync(join(raiz, arquivo), "utf8");
      const codigo = fonte
        .split("\n")
        .filter((l) => {
          const t = l.trimStart();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");
      assert.equal(
        /planoPreco\.(create|upsert)|precoCentavos\s*:/.test(codigo),
        false,
        `${arquivo} não pode criar preço`,
      );
    }
  });
});

// ── 4. O plano padrão continua intocado ──────────────────────────────────────

describe("gratuito não é afetado pela matriz", () => {
  /**
   * O índice único parcial do banco garante no máximo um `ehPadrao`. Um segundo
   * `true` aqui faria o seed falhar em produção — e, pior, se passasse, faria a
   * resolução de "conta sem assinatura" depender da ordem de leitura.
   */
  test("nenhum comercial é ehPadrao", () => {
    for (const p of PLANOS_COMERCIAIS) assert.equal(p.ehPadrao, false);
    assert.equal(PLANO_GRATUITO.ehPadrao, true);
    assert.equal([PLANO_GRATUITO, ...PLANOS_COMERCIAIS].filter((p) => p.ehPadrao).length, 1);
  });

  /**
   * O gratuito passou a ser o degrau mais baixo da matriz, por decisão
   * aprovada. O que este teste guarda agora é a **coerência da escada**: ele
   * precisa ficar em todo direito abaixo ou igual ao Basic, nunca acima.
   *
   * Editar a constante não muda produção — o seed nunca sobrescreve. Quem aplica
   * à linha existente é `scripts/ajustar-plano-gratuito.ts`.
   */
  test("gratuito é o degrau mais baixo, e não supera o Basic em nada", () => {
    assert.equal(PLANO_GRATUITO.telasMax, 1);
    assert.equal(PLANO_GRATUITO.downloads, false);
    assert.equal(PLANO_GRATUITO.canaisNivel, "nenhum");
    assert.equal(PLANO_GRATUITO.resolucaoMax, "sd");
    assert.equal(PLANO_GRATUITO.tvNivel, "limitado");

    assert.deepEqual(
      inversoesDeDireito(PLANO_GRATUITO),
      [],
      "com estes valores não pode sobrar nenhuma inversão contra os planos pagos",
    );
  });

  /**
   * O contraponto: `filmes` e `series` continuam liberados. A diferenciação
   * comercial está em telas, download, canais e qualidade — não em cortar
   * catálogo de quem não paga.
   */
  test("o gratuito não perde acesso a filmes e séries", () => {
    assert.equal(PLANO_GRATUITO.filmes, true);
    assert.equal(PLANO_GRATUITO.series, true);
  });

  test("os quatro ids são distintos", () => {
    const ids = [PLANO_GRATUITO, ...PLANOS_COMERCIAIS].map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

// ── 5. O seed ────────────────────────────────────────────────────────────────

describe("seed da matriz: cria se faltar, nunca sobrescreve", () => {
  function repositorioFalso(iniciais: Record<string, unknown>[] = []) {
    const linhas = new Map<string, Record<string, unknown>>();
    for (const l of iniciais) linhas.set(String(l.id), { ...l });
    let criacoes = 0;

    const repo: RepositorioDePlanos = {
      async buscar(id) {
        return linhas.get(id) ?? null;
      },
      async criar(plano) {
        criacoes++;
        linhas.set(plano.id, { ...plano });
      },
    };
    return { repo, linhas, criacoes: () => criacoes };
  }

  test("banco vazio: cria as três, uma vez cada", async () => {
    const { repo, linhas, criacoes } = repositorioFalso();

    const r = await semearPlanosComerciais(repo);

    assert.equal(criacoes(), 3);
    assert.deepEqual([...linhas.keys()], ["basic", "plus", "premium"]);
    for (const item of r) assert.equal(item.resultado.acao, "criado");
  });

  test("segunda execução não grava de novo", async () => {
    const { repo, criacoes } = repositorioFalso();
    await semearPlanosComerciais(repo);

    const r = await semearPlanosComerciais(repo);

    assert.equal(criacoes(), 3, "não pode ter havido uma segunda escrita");
    for (const item of r) assert.equal(item.resultado.acao, "mantido");
  });

  /** O teste que impede o reset comercial de produção. */
  test("plano já ajustado comercialmente NÃO é sobrescrito", async () => {
    // Um banco onde a curadoria decidiu que Basic perde séries e ganha 1 tela.
    const basicEmProducao = { ...PLANO_BASIC, series: false, telasMax: 1, ativo: false };
    const { repo, linhas, criacoes } = repositorioFalso([basicEmProducao]);

    await semearPlanosComerciais(repo);

    assert.equal(criacoes(), 2, "só plus e premium deveriam ter sido criados");
    assert.deepEqual(linhas.get("basic"), basicEmProducao);
  });

  test("semeia só o que falta, sem tocar no resto", async () => {
    const { repo, linhas, criacoes } = repositorioFalso([{ ...PLANO_PLUS }]);

    await semearPlanosComerciais(repo);

    assert.equal(criacoes(), 2);
    assert.equal(linhas.size, 3);
  });

  test("semearPlano é o mesmo contrato, para um plano qualquer", async () => {
    const { repo, criacoes } = repositorioFalso();

    assert.equal((await semearPlano(repo, PLANO_PREMIUM)).acao, "criado");
    assert.equal((await semearPlano(repo, PLANO_PREMIUM)).acao, "mantido");
    assert.equal(criacoes(), 1);
  });

  /** Nenhuma conta é tocada, e nenhum canal tampouco. */
  test("o seed não conhece Assinatura nem Canal", () => {
    const fonte = readFileSync(join(raiz, "scripts/seed-planos.ts"), "utf8");
    const codigo = fonte
      .split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

    for (const proibido of [
      "assinatura.create",
      "assinatura.update",
      "canal.",
      "nivelMinimo",
      "plano.update",
      "plano.upsert",
      "deleteMany",
    ]) {
      assert.equal(codigo.includes(proibido), false, `${proibido} não pertence ao seed`);
    }
    // Contar assinaturas é leitura, e é o que prova que nenhuma foi criada.
    assert.ok(codigo.includes("assinatura.count"));
  });
});

// ── 6. "Servidor VIP" não é fingido ──────────────────────────────────────────

describe("o que a matriz NÃO promete", () => {
  /**
   * Premium fala em "servidores VIP", mas não existe hoje separação de fontes
   * por plano no backend — `fontes.ts` monta a mesma lista para todo mundo.
   * Enquanto isso for verdade, não pode existir um campo que finja a
   * diferenciação: um booleano `servidorVip` gravado e não aplicado viraria
   * texto de vitrine sustentado por nada.
   */
  test("nenhum campo de fonte/servidor VIP foi inventado no plano", () => {
    for (const p of [PLANO_GRATUITO, ...PLANOS_COMERCIAIS]) {
      const campos = Object.keys(p).join(" ").toLowerCase();
      for (const inventado of ["vip", "servidor", "fonte", "suporte", "prioritario"]) {
        assert.equal(
          campos.includes(inventado),
          false,
          `"${inventado}" viraria promessa sem enforcement — deixe como requisito futuro`,
        );
      }
    }
  });

  /**
   * `PlanoSemeado` continua sendo exatamente as colunas que o banco tem. Se
   * alguém acrescentar um direito aqui sem migration, o seed quebra no
   * `prisma.plano.create` — em produção, não no CI.
   */
  test("os planos comerciais têm exatamente as chaves do plano padrão", () => {
    const doPadrao = Object.keys(PLANO_GRATUITO).sort();
    for (const p of PLANOS_COMERCIAIS) {
      assert.deepEqual(Object.keys(p).sort(), doPadrao, `${p.id} tem colunas a mais ou a menos`);
    }
  });
});
