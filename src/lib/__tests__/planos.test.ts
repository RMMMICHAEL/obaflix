import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PLANO_BASIC,
  PLANO_GRATUITO,
  TELAS_SIMULTANEAS_HOJE,
  CANAIS_NIVEIS,
  RESOLUCOES,
  TV_NIVEIS,
  STATUS_ASSINATURA,
  ORIGENS_ASSINATURA,
  diferencas,
  semearPlanoPadrao,
  type RepositorioDePlanos,
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

/**
 * O plano padrão deixou de ser a fotografia do comportamento atual.
 *
 * Era, até a matriz comercial ser aprovada: reproduzia o que toda conta tem hoje
 * para que a Fase 1 não mudasse o comportamento de ninguém. Agora é o degrau
 * mais baixo da matriz e precisa ficar **abaixo** do Basic pago — senão vender
 * Basic seria oferecer menos por dinheiro do que a conta já tem de graça.
 */
describe("plano padrão: o degrau mais baixo da matriz", () => {
  test("é o plano padrão, e está ativo", () => {
    assert.equal(PLANO_GRATUITO.id, "gratuito");
    assert.equal(PLANO_GRATUITO.ehPadrao, true);
    assert.equal(PLANO_GRATUITO.ativo, true);
  });

  /**
   * Ligado por decisão comercial, e **sem enforcement hoje**: nenhuma rota lê
   * este campo, e a interface não simula anúncio nenhum. É intenção registrada,
   * que passa a valer quando a fase de anúncios existir.
   */
  test("exige anúncio, sem contador pendurado até a fase de anúncios", () => {
    assert.equal(PLANO_GRATUITO.anunciosObrigatorios, true);
    assert.equal(PLANO_GRATUITO.episodiosPorAnuncio, null);
  });

  test("mantém filmes e séries — a diferenciação não é cortar catálogo", () => {
    assert.equal(PLANO_GRATUITO.filmes, true);
    assert.equal(PLANO_GRATUITO.series, true);
  });

  test("sem downloads: empata com Basic e fica abaixo de Plus e Premium", () => {
    assert.equal(PLANO_GRATUITO.downloads, false);
  });

  test("qualidade e TV no piso da escala", () => {
    assert.equal(PLANO_GRATUITO.resolucaoMax, "sd");
    assert.equal(PLANO_GRATUITO.tvNivel, "limitado");
  });

  test("canais em 'nenhum': canal é direito de Plus e Premium", () => {
    assert.equal(PLANO_GRATUITO.canaisNivel, "nenhum");
  });

  test("perfis em 1: não existem no schema", () => {
    assert.equal(PLANO_GRATUITO.perfisMax, 1);
  });

  /**
   * `TELAS_SIMULTANEAS_HOJE` continua espelhando `MAX_CONCURRENT`, e o teste
   * continua lendo o arquivo em vez de repetir o número.
   *
   * O que mudou foi o **significado**: aquela constante não é mais o `telasMax`
   * do plano padrão. Ela é o limite que vale enquanto `MONETIZACAO_ATIVA`
   * estiver desligada — o mesmo valor que `limiteDeTelas` devolve no bypass da
   * flag. As duas coisas respondem a perguntas diferentes desde a matriz
   * comercial, e a segunda asserção deste teste (que exigia os dois iguais) saiu
   * por isso, não por conveniência.
   */
  test("TELAS_SIMULTANEAS_HOJE acompanha o MAX_CONCURRENT real de playTokens.ts", () => {
    const fonte = readFileSync(join(raiz, "src/lib/playTokens.ts"), "utf8");
    const achado = fonte.match(/const\s+MAX_CONCURRENT\s*=\s*(\d+)/);

    assert.ok(
      achado,
      "MAX_CONCURRENT não foi encontrado em playTokens.ts — se ele mudou de " +
        "nome ou de forma, esta comparação precisa acompanhar em vez de sumir",
    );

    assert.equal(
      TELAS_SIMULTANEAS_HOJE,
      Number(achado[1]),
      "TELAS_SIMULTANEAS_HOJE saiu de sincronia com MAX_CONCURRENT",
    );
  });

  /**
   * Uma tela, e o campo mais visível desta decisão.
   *
   * É o único direito do gratuito com enforcement real hoje: no dia em que
   * `MONETIZACAO_ATIVA` ligar, toda conta sem assinatura cai de 5 para 1 stream
   * simultâneo. Está travado aqui para que a queda seja sempre uma decisão
   * escrita, e nunca efeito colateral de alguém "arredondando" o valor.
   */
  test("telasMax é 1, e está abaixo do Basic pago", () => {
    assert.equal(PLANO_GRATUITO.telasMax, 1);
    assert.ok(
      PLANO_GRATUITO.telasMax < PLANO_BASIC.telasMax,
      "o gratuito não pode dar mais telas que o Basic pago",
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

  /**
   * Todo direito nasce fechado.
   *
   * O default de coluna é o que vale para um plano criado sem informar um
   * campo — pelo Studio, por um script futuro, por um seed de outro ambiente.
   * Se ele conceder, o erro é silencioso: o plano funciona, e concede a mais.
   *
   * `anunciosObrigatorios` é o único `true`, e é o mesmo princípio: `true` ali
   * significa "exige anúncio", que é o lado restritivo.
   */
  test("os defaults da migration não concedem nada", () => {
    const restritivos: [string, string][] = [
      ["anunciosObrigatorios", "BOOLEAN NOT NULL DEFAULT true"],
      ["filmes", "BOOLEAN NOT NULL DEFAULT false"],
      ["series", "BOOLEAN NOT NULL DEFAULT false"],
      ["downloads", "BOOLEAN NOT NULL DEFAULT false"],
      ["ehPadrao", "BOOLEAN NOT NULL DEFAULT false"],
      ["canaisNivel", "TEXT NOT NULL DEFAULT 'nenhum'"],
      ["resolucaoMax", "TEXT NOT NULL DEFAULT 'hd'"],
      ["tvNivel", "TEXT NOT NULL DEFAULT 'limitado'"],
      ["telasMax", "INTEGER NOT NULL DEFAULT 1"],
      ["perfisMax", "INTEGER NOT NULL DEFAULT 1"],
    ];

    for (const [coluna, esperado] of restritivos) {
      assert.ok(
        migracao.includes(`"${coluna}" ${esperado}`),
        `o default de ${coluna} deixou de ser o restritivo (esperado: ${esperado})`,
      );
    }
  });

  test("o seed escreve cada direito, em vez de herdar default", () => {
    // O contraponto do teste acima: com defaults fechados, o que o gratuito
    // concede só existe porque está escrito. Depois da matriz comercial ele
    // concede pouco — mas continua escrevendo, e é isso que este teste guarda:
    // `filmes` e `series` são liberações explícitas sobre um default `false`.
    assert.equal(PLANO_GRATUITO.filmes, true);
    assert.equal(PLANO_GRATUITO.series, true);
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

/**
 * O seed cria se faltar e **nunca sobrescreve**.
 *
 * `PLANO_GRATUITO` é bootstrap; depois que a linha existe, o Postgres é a fonte
 * de verdade. O cenário que estes testes existem para tornar impossível:
 *
 *   produção com anunciosObrigatorios=true, downloads=false, telasMax=1
 *   → alguém roda `seed:planos:apply`
 *   → a monetização é desligada e os direitos reabrem, sem ninguém pedir.
 *
 * Os testes exercitam `semearPlanoPadrao` — a função que o script chama de
 * verdade — contra um repositório em memória, e não uma reimplementação dela.
 */
describe("seed: cria se faltar, nunca sobrescreve", () => {
  function repositorioFalso(inicial?: Record<string, unknown>) {
    const linhas = new Map<string, Record<string, unknown>>();
    if (inicial) linhas.set(String(inicial.id), { ...inicial });
    let criacoes = 0;
    const repo: RepositorioDePlanos & { linhas: typeof linhas; criacoes: () => number } = {
      linhas,
      criacoes: () => criacoes,
      async buscar(id) {
        return linhas.get(id) ?? null;
      },
      async criar(plano) {
        criacoes++;
        linhas.set(plano.id, { ...plano });
      },
    };
    return repo;
  }

  test("primeira execução cria exatamente uma linha", async () => {
    const repo = repositorioFalso();

    const r = await semearPlanoPadrao(repo, PLANO_GRATUITO);

    assert.equal(r.acao, "criado");
    assert.equal(repo.linhas.size, 1);
    assert.equal(repo.criacoes(), 1);
    assert.deepEqual(repo.linhas.get("gratuito"), { ...PLANO_GRATUITO });
  });

  test("segunda execução continua uma linha, sem gravar de novo", async () => {
    const repo = repositorioFalso();
    await semearPlanoPadrao(repo, PLANO_GRATUITO);
    const depoisDaPrimeira = { ...repo.linhas.get("gratuito") };

    const r = await semearPlanoPadrao(repo, PLANO_GRATUITO);

    assert.equal(r.acao, "mantido");
    assert.equal(repo.linhas.size, 1);
    assert.equal(repo.criacoes(), 1, "não pode ter havido uma segunda escrita");
    assert.deepEqual(repo.linhas.get("gratuito"), depoisDaPrimeira);
  });

  /** O teste que impede o reset de produção. */
  test("plano já ajustado comercialmente NÃO é sobrescrito", async () => {
    // Um banco com a monetização ligada: exige anúncio, sem download, 1 tela.
    const emProducao = {
      ...PLANO_GRATUITO,
      anunciosObrigatorios: true,
      episodiosPorAnuncio: 3,
      downloads: false,
      telasMax: 1,
      resolucaoMax: "hd",
      tvNivel: "limitado",
    };
    const repo = repositorioFalso(emProducao);

    const r = await semearPlanoPadrao(repo, PLANO_GRATUITO);

    assert.equal(r.acao, "mantido");
    assert.equal(repo.criacoes(), 0);
    assert.deepEqual(
      repo.linhas.get("gratuito"),
      emProducao,
      "o seed reabriu direitos que o banco havia fechado",
    );
  });

  test("alteração manual de uma única coluna também sobrevive", async () => {
    const repo = repositorioFalso({ ...PLANO_GRATUITO, telasMax: 2 });

    await semearPlanoPadrao(repo, PLANO_GRATUITO);

    assert.equal(repo.linhas.get("gratuito")!.telasMax, 2);
  });

  test("a criação grava todo campo do plano, id incluído", async () => {
    const repo = repositorioFalso();
    await semearPlanoPadrao(repo, PLANO_GRATUITO);

    assert.deepEqual(
      Object.keys(repo.linhas.get("gratuito")!).sort(),
      Object.keys(PLANO_GRATUITO).sort(),
    );
  });
});

describe("diferencas: relata sem agir", () => {
  /**
   * Os valores usados aqui são os que a linha de produção realmente tem: ela
   * nasceu antes da matriz comercial, com 5 telas e sem anúncio. É exatamente
   * essa divergência que o seed precisa relatar sem agir sobre ela.
   */
  test("aponta cada direito que o banco tem diferente da fotografia", () => {
    const noBanco = {
      ...PLANO_GRATUITO,
      anunciosObrigatorios: false,
      telasMax: 5,
    };

    const d = diferencas(noBanco, PLANO_GRATUITO);
    const campos = d.map((x) => x.campo).sort();

    assert.deepEqual(campos, ["anunciosObrigatorios", "telasMax"]);
  });

  test("linha igual à fotografia não gera diferença", () => {
    assert.deepEqual(diferencas({ ...PLANO_GRATUITO }, PLANO_GRATUITO), []);
  });

  test("coluna que o banco não devolve não vira diferença falsa", () => {
    // A linha real traz criadoEm/atualizadoEm e pode não trazer algo que a
    // fotografia tem, se o schema andar. Ausente não é divergente.
    const parcial = { id: "gratuito", telasMax: PLANO_GRATUITO.telasMax };
    assert.deepEqual(diferencas(parcial, PLANO_GRATUITO), []);
  });
});
