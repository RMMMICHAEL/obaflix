import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  EntitlementsIndefinidos,
  TTL_ENTITLEMENTS_SEG,
  argumentosDaConsulta,
  assinaturaValida,
  cacheAindaVale,
  chaveEntitlements,
  ttlDoCache,
  entitlementsDoUsuario,
  invalidarEntitlements,
  planoDaLinha,
  resolverEntitlements,
  reviverEntitlements,
  type AssinaturaCandidata,
  type CacheDeEntitlements,
  type Entitlements,
  type FonteDeEntitlements,
  type PlanoAutorizador,
} from "../entitlements";

/**
 * A resolução de direitos, exercitada sem banco e sem Redis.
 *
 * A regra inteira vive em `resolverEntitlements`, que é pura — então tudo que
 * importa é testável assim. A infraestrutura entra por injeção, e o que se
 * verifica dela é o contrato: quando consulta, quando não consulta, o que grava
 * e o que recusa.
 *
 * Nenhum teste aqui depende de `DATABASE_URL` ou de `UPSTASH_*`.
 */

const AGORA = new Date("2026-09-15T12:00:00.000Z");
const emMinutos = (m: number) => new Date(AGORA.getTime() + m * 60_000);

/** Um plano restritivo, para servir de padrão nos testes. */
function planoPadraoRestrito(
  over: Partial<PlanoAutorizador & { ativo: boolean }> = {},
): PlanoAutorizador & { ativo: boolean } {
  return {
    id: "gratuito",
    anunciosObrigatorios: true,
    episodiosPorAnuncio: 3,
    janelaAnuncioHoras: 24,
    filmes: true,
    series: true,
    canaisNivel: "nenhum",
    downloads: false,
    telasMax: 1,
    perfisMax: 1,
    resolucaoMax: "hd",
    tvNivel: "limitado",
    ativo: true,
    ...over,
  };
}

/** Um plano generoso, para servir de plano comprado. */
function planoPago(over: Partial<PlanoAutorizador> = {}): PlanoAutorizador {
  return {
    id: "plus",
    anunciosObrigatorios: false,
    episodiosPorAnuncio: null,
    janelaAnuncioHoras: 24,
    filmes: true,
    series: true,
    canaisNivel: "plus",
    downloads: true,
    telasMax: 2,
    perfisMax: 3,
    resolucaoMax: "4k",
    tvNivel: "completo",
    ...over,
  };
}

function assinatura(over: Partial<AssinaturaCandidata> = {}): AssinaturaCandidata {
  return {
    id: "a1",
    status: "ATIVA",
    iniciaEm: emMinutos(-60),
    terminaEm: emMinutos(60),
    plano: planoPago(),
    ...over,
  };
}

// ── A regra pura ─────────────────────────────────────────────────────────────

describe("resolverEntitlements: qual plano responde", () => {
  test("sem nenhuma assinatura, responde o plano padrão", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [],
      planoPadrao: planoPadraoRestrito(),
    });

    assert.equal(r.assinatura.ativa, false);
    assert.equal(r.assinatura.planoId, "gratuito");
    assert.equal(r.assinatura.expiraEm, null);
    assert.equal(r.direitos.downloads, false);
    assert.equal(r.direitos.telasMax, 1);
  });

  test("assinatura ATIVA dentro da janela responde com o plano dela", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [assinatura()],
      planoPadrao: planoPadraoRestrito(),
    });

    assert.equal(r.assinatura.ativa, true);
    assert.equal(r.assinatura.planoId, "plus");
    assert.deepEqual(r.assinatura.expiraEm, emMinutos(60));
    assert.equal(r.direitos.downloads, true);
    assert.equal(r.direitos.telasMax, 2);
    assert.equal(r.direitos.canaisNivel, "plus");
  });

  for (const status of ["CANCELADA", "EXPIRADA", "SUSPENSA"] as const) {
    test(`status ${status} dentro da janela NÃO vale — cai no padrão`, () => {
      const r = resolverEntitlements({
        agora: AGORA,
        candidatas: [assinatura({ status })],
        planoPadrao: planoPadraoRestrito(),
      });

      assert.equal(r.assinatura.ativa, false);
      assert.equal(r.assinatura.planoId, "gratuito");
      assert.equal(r.direitos.downloads, false);
    });
  }
});

describe("a janela é [iniciaEm, terminaEm)", () => {
  test("ATIVA que ainda vai começar não vale", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [assinatura({ iniciaEm: emMinutos(1), terminaEm: emMinutos(60) })],
      planoPadrao: planoPadraoRestrito(),
    });
    assert.equal(r.assinatura.ativa, false);
  });

  test("começando exatamente agora, já vale — o início é fechado", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [assinatura({ iniciaEm: new Date(AGORA), terminaEm: emMinutos(60) })],
      planoPadrao: planoPadraoRestrito(),
    });
    assert.equal(r.assinatura.ativa, true);
    assert.equal(r.assinatura.planoId, "plus");
  });

  test("terminando exatamente agora, já não vale — o fim é aberto", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [assinatura({ iniciaEm: emMinutos(-60), terminaEm: new Date(AGORA) })],
      planoPadrao: planoPadraoRestrito(),
    });
    assert.equal(r.assinatura.ativa, false);
    assert.equal(r.assinatura.planoId, "gratuito");
  });

  test("um milissegundo antes do fim ainda vale", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [assinatura({ terminaEm: new Date(AGORA.getTime() + 1) })],
      planoPadrao: planoPadraoRestrito(),
    });
    assert.equal(r.assinatura.ativa, true);
  });

  test("assinaturaValida concorda com a resolução, isoladamente", () => {
    assert.equal(assinaturaValida(assinatura(), AGORA), true);
    assert.equal(assinaturaValida(assinatura({ status: "CANCELADA" }), AGORA), false);
    assert.equal(assinaturaValida(assinatura({ terminaEm: new Date(AGORA) }), AGORA), false);
    assert.equal(assinaturaValida(assinatura({ iniciaEm: new Date(AGORA) }), AGORA), true);
  });
});

describe("Plano.ativo separa venda de validade", () => {
  test("plano fora de venda preserva quem já comprou", () => {
    // `ativo = false` significa "saiu do catálogo comercial", não "caducou".
    // Rebaixar aqui tiraria, sem aviso, o direito de quem pagou.
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [assinatura({ plano: planoPago({ id: "plus-descontinuado" }) })],
      planoPadrao: planoPadraoRestrito(),
    });

    assert.equal(r.assinatura.ativa, true);
    assert.equal(r.assinatura.planoId, "plus-descontinuado");
    assert.equal(r.direitos.telasMax, 2);
  });

  test("mas o plano PADRÃO precisa estar ativo", () => {
    assert.throws(
      () =>
        resolverEntitlements({
          agora: AGORA,
          candidatas: [],
          planoPadrao: planoPadraoRestrito({ ativo: false }),
        }),
      (e: unknown) =>
        e instanceof EntitlementsIndefinidos && e.motivo === "sem_plano_padrao",
    );
  });
});

describe("estados ambíguos falham, não inventam direito", () => {
  test("sem plano padrão, lança em vez de devolver algo permissivo", () => {
    assert.throws(
      () => resolverEntitlements({ agora: AGORA, candidatas: [], planoPadrao: null }),
      (e: unknown) =>
        e instanceof EntitlementsIndefinidos && e.motivo === "sem_plano_padrao",
    );
  });

  test("assinatura válida sem plano lança — não rebaixa para o padrão em silêncio", () => {
    assert.throws(
      () =>
        resolverEntitlements({
          agora: AGORA,
          candidatas: [assinatura({ plano: null })],
          planoPadrao: planoPadraoRestrito(),
        }),
      (e: unknown) =>
        e instanceof EntitlementsIndefinidos &&
        e.motivo === "plano_da_assinatura_ausente",
    );
  });

  test("duas assinaturas válidas ao mesmo tempo lançam", () => {
    // Escolher uma seria inventar regra comercial: maior privilégio favorece
    // quem duplicou, mais recente favorece quem recomprou, mais antiga pune
    // quem fez upgrade. A trava no banco fica para a fase de renovação.
    assert.throws(
      () =>
        resolverEntitlements({
          agora: AGORA,
          candidatas: [
            assinatura({ id: "a1", plano: planoPago({ id: "basico" }) }),
            assinatura({ id: "a2", plano: planoPago({ id: "premium" }) }),
          ],
          planoPadrao: planoPadraoRestrito(),
        }),
      (e: unknown) =>
        e instanceof EntitlementsIndefinidos &&
        e.motivo === "assinaturas_ambiguas" &&
        /a1/.test(e.detalhe ?? "") &&
        /a2/.test(e.detalhe ?? ""),
    );
  });

  test("duas assinaturas, só uma válida, não é ambiguidade", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [
        assinatura({ id: "velha", status: "EXPIRADA" }),
        assinatura({ id: "atual", plano: planoPago({ id: "premium" }) }),
      ],
      planoPadrao: planoPadraoRestrito(),
    });
    assert.equal(r.assinatura.planoId, "premium");
  });
});

describe("os direitos vêm das colunas, nunca da identidade do plano", () => {
  test("um plano chamado premium com direitos restritos entrega restrito", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [
        assinatura({
          plano: planoPago({
            id: "premium",
            downloads: false,
            canaisNivel: "nenhum",
            telasMax: 1,
            resolucaoMax: "sd",
            tvNivel: "nenhum",
            anunciosObrigatorios: true,
          }),
        }),
      ],
      planoPadrao: planoPadraoRestrito(),
    });

    assert.equal(r.assinatura.planoId, "premium");
    assert.equal(r.direitos.downloads, false);
    assert.equal(r.direitos.canaisNivel, "nenhum");
    assert.equal(r.direitos.telasMax, 1);
    assert.equal(r.direitos.resolucaoMax, "sd");
    assert.equal(r.direitos.tvNivel, "nenhum");
    assert.equal(r.direitos.anunciosObrigatorios, true);
  });

  test("a saída carrega só os onze direitos, sem sobras do Plano", () => {
    const r = resolverEntitlements({
      agora: AGORA,
      candidatas: [],
      planoPadrao: planoPadraoRestrito(),
    });

    assert.deepEqual(Object.keys(r.direitos).sort(), [
      "anunciosObrigatorios", "canaisNivel", "downloads", "episodiosPorAnuncio",
      "filmes", "janelaAnuncioHoras", "perfisMax", "resolucaoMax", "series",
      "telasMax", "tvNivel",
    ]);
    assert.deepEqual(Object.keys(r.assinatura).sort(), ["ativa", "expiraEm", "planoId"]);
  });
});

describe("planoDaLinha: domínio fechado é conferido, não convertido", () => {
  const linhaBase = {
    id: "x",
    anunciosObrigatorios: true,
    episodiosPorAnuncio: null,
    janelaAnuncioHoras: 24,
    filmes: true,
    series: true,
    canaisNivel: "plus",
    downloads: false,
    telasMax: 1,
    perfisMax: 1,
    resolucaoMax: "hd",
    tvNivel: "limitado",
  };

  test("linha válida atravessa", () => {
    assert.equal(planoDaLinha(linhaBase).canaisNivel, "plus");
  });

  for (const [campo, valor] of [
    ["canaisNivel", "ouro"],
    ["resolucaoMax", "8k"],
    ["tvNivel", "parcial"],
  ] as const) {
    test(`${campo} fora do domínio lança em vez de virar direito`, () => {
      assert.throws(
        () => planoDaLinha({ ...linhaBase, [campo]: valor }),
        (e: unknown) =>
          e instanceof EntitlementsIndefinidos &&
          e.motivo === "direito_fora_do_dominio",
      );
    });
  }
});

// ── Cache ────────────────────────────────────────────────────────────────────

function cacheFalso(inicial?: Record<string, string>) {
  const mapa = new Map<string, string>(Object.entries(inicial ?? {}));
  const registro = { leituras: 0, gravacoes: 0, remocoes: 0, ttls: [] as number[], chaves: [] as string[] };
  const cache: CacheDeEntitlements = {
    async ler(chave) {
      registro.leituras++;
      registro.chaves.push(chave);
      return mapa.get(chave) ?? null;
    },
    async gravar(chave, valor, ttlSeg) {
      registro.gravacoes++;
      registro.ttls.push(ttlSeg);
      mapa.set(chave, valor);
    },
    async apagar(chave) {
      registro.remocoes++;
      registro.chaves.push(chave);
      mapa.delete(chave);
    },
  };
  return { cache, mapa, registro };
}

function fonteFalsa(
  candidatas: AssinaturaCandidata[],
  planoPadrao: (PlanoAutorizador & { ativo: boolean }) | null = planoPadraoRestrito(),
) {
  const registro = { consultas: 0 };
  const fonte: FonteDeEntitlements = {
    async candidatas() {
      registro.consultas++;
      return candidatas;
    },
    async planoPadrao() {
      return planoPadrao;
    },
  };
  return { fonte, registro };
}

const fonteQueExplode: FonteDeEntitlements = {
  async candidatas() {
    throw new Error("o Postgres não deveria ter sido consultado");
  },
  async planoPadrao() {
    throw new Error("o Postgres não deveria ter sido consultado");
  },
};

describe("chave do cache", () => {
  test("é versionada e carrega o usuário", () => {
    assert.equal(chaveEntitlements("u123"), "entitlements:v1:user:u123");
  });

  test("usuários diferentes não compartilham entrada", () => {
    assert.notEqual(chaveEntitlements("a"), chaveEntitlements("b"));
  });
});

describe("entitlementsDoUsuario: cache antes do banco", () => {
  test("cache miss consulta o Postgres e grava com TTL de 120 s", async () => {
    const { cache, registro: reg } = cacheFalso();
    const { fonte, registro: fonteReg } = fonteFalsa([assinatura()]);

    const r = await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });

    assert.equal(r.assinatura.planoId, "plus");
    assert.equal(fonteReg.consultas, 1);
    assert.equal(reg.gravacoes, 1);
    assert.deepEqual(reg.ttls, [TTL_ENTITLEMENTS_SEG]);
    assert.equal(TTL_ENTITLEMENTS_SEG, 120);
    assert.ok(reg.chaves.includes("entitlements:v1:user:u1"));
  });

  test("cache hit válido não toca no Postgres", async () => {
    const { cache } = cacheFalso();
    const { fonte } = fonteFalsa([assinatura()]);

    const primeira = await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });
    // A segunda usa uma fonte que lança se for consultada.
    const segunda = await entitlementsDoUsuario("u1", {
      fonte: fonteQueExplode,
      cache,
      agora: AGORA,
    });

    assert.deepEqual(segunda, primeira);
  });

  test("o cache devolve expiraEm como Date, não como a string do JSON", async () => {
    const { cache } = cacheFalso();
    const { fonte } = fonteFalsa([assinatura()]);

    await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });
    const doCache = await entitlementsDoUsuario("u1", {
      fonte: fonteQueExplode,
      cache,
      agora: AGORA,
    });

    // Se o tipo divergisse entre cache e banco, a diferença só apareceria em
    // produção — é o mesmo cuidado que `redis.ts` documenta em `get`.
    assert.ok(doCache.assinatura.expiraEm instanceof Date);
    assert.equal(doCache.assinatura.expiraEm?.toISOString(), emMinutos(60).toISOString());
  });

  test("cada usuário resolve o seu", async () => {
    const { cache } = cacheFalso();
    const comPlano = fonteFalsa([assinatura()]);
    const semPlano = fonteFalsa([]);

    const a = await entitlementsDoUsuario("u1", { fonte: comPlano.fonte, cache, agora: AGORA });
    const b = await entitlementsDoUsuario("u2", { fonte: semPlano.fonte, cache, agora: AGORA });

    assert.equal(a.assinatura.planoId, "plus");
    assert.equal(b.assinatura.planoId, "gratuito");
  });
});

describe("cache inválido nunca concede", () => {
  const lixos: [string, string][] = [
    ["json quebrado", "{isto não é json"],
    ["json que não é objeto", '"texto"'],
    ["objeto vazio", "{}"],
    ["sem direitos", '{"assinatura":{"ativa":false,"planoId":"x","expiraEm":null}}'],
    [
      "direito booleano trocado por string",
      '{"assinatura":{"ativa":false,"planoId":"x","expiraEm":null},"direitos":{"anunciosObrigatorios":"false","episodiosPorAnuncio":null,"janelaAnuncioHoras":24,"filmes":true,"series":true,"canaisNivel":"nenhum","downloads":true,"telasMax":5,"perfisMax":1,"resolucaoMax":"4k","tvNivel":"completo"}}',
    ],
    [
      "canaisNivel fora do domínio",
      '{"assinatura":{"ativa":false,"planoId":"x","expiraEm":null},"direitos":{"anunciosObrigatorios":false,"episodiosPorAnuncio":null,"janelaAnuncioHoras":24,"filmes":true,"series":true,"canaisNivel":"ouro","downloads":true,"telasMax":5,"perfisMax":1,"resolucaoMax":"4k","tvNivel":"completo"}}',
    ],
    [
      "ativa=true sem expiraEm",
      '{"assinatura":{"ativa":true,"planoId":"x","expiraEm":null},"direitos":{"anunciosObrigatorios":false,"episodiosPorAnuncio":null,"janelaAnuncioHoras":24,"filmes":true,"series":true,"canaisNivel":"plus","downloads":true,"telasMax":5,"perfisMax":1,"resolucaoMax":"4k","tvNivel":"completo"}}',
    ],
    ["campo direitos nulo", '{"assinatura":{"ativa":false,"planoId":"x","expiraEm":null},"direitos":null}'],
  ];

  for (const [nome, bruto] of lixos) {
    test(`reviver recusa: ${nome}`, () => {
      assert.equal(reviverEntitlements(bruto), null);
    });
  }

  test("entrada corrompida faz consultar o banco, e o resultado é o restritivo", async () => {
    // O ponto: o cache trazia direitos generosos, mas inválidos. O que vale é
    // o que o Postgres respondeu — plano padrão restritivo — e não o lixo.
    const permissivoPorem_invalido =
      '{"assinatura":{"ativa":true,"planoId":"hackeado","expiraEm":null},"direitos":{"downloads":true,"telasMax":99}}';
    const { cache, mapa, registro: reg } = cacheFalso({
      "entitlements:v1:user:u1": permissivoPorem_invalido,
    });
    const { fonte, registro: fonteReg } = fonteFalsa([]);

    const r = await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });

    assert.equal(fonteReg.consultas, 1, "deveria ter ido ao Postgres");
    assert.equal(r.assinatura.ativa, false);
    assert.equal(r.assinatura.planoId, "gratuito");
    assert.equal(r.direitos.downloads, false);
    assert.equal(r.direitos.telasMax, 1);

    // E a entrada ruim foi substituída por uma válida.
    assert.equal(reg.gravacoes, 1);
    assert.notEqual(mapa.get("entitlements:v1:user:u1"), permissivoPorem_invalido);
    assert.ok(reviverEntitlements(mapa.get("entitlements:v1:user:u1")!));
  });

  test("o que este módulo grava, ele consegue reler", async () => {
    const { cache, mapa } = cacheFalso();
    const { fonte } = fonteFalsa([assinatura()]);

    const original = await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });
    const relido = reviverEntitlements(mapa.get("entitlements:v1:user:u1")!);

    assert.deepEqual(relido, original as Entitlements);
  });
});

describe("falha de cache não vira permissão", () => {
  const cacheQuebrado: CacheDeEntitlements = {
    async ler() {
      throw new Error("redis fora do ar");
    },
    async gravar() {
      throw new Error("redis fora do ar");
    },
    async apagar() {
      throw new Error("redis fora do ar");
    },
  };

  test("leitura e gravação falhando, a resposta ainda vem do Postgres", async () => {
    const { fonte, registro } = fonteFalsa([]);

    const r = await entitlementsDoUsuario("u1", { fonte, cache: cacheQuebrado, agora: AGORA });

    assert.equal(registro.consultas, 1);
    assert.equal(r.assinatura.planoId, "gratuito");
    assert.equal(r.direitos.downloads, false);
  });

  test("banco inconsistente propaga o erro em vez de virar direito", async () => {
    const { fonte } = fonteFalsa([], null);

    await assert.rejects(
      () => entitlementsDoUsuario("u1", { fonte, cache: cacheQuebrado, agora: AGORA }),
      (e: unknown) =>
        e instanceof EntitlementsIndefinidos && e.motivo === "sem_plano_padrao",
    );
  });

  test("inconsistência do banco não é memorizada no cache", async () => {
    const { cache, registro: reg } = cacheFalso();
    const { fonte } = fonteFalsa([], null);

    await assert.rejects(() =>
      entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA }),
    );

    assert.equal(reg.gravacoes, 0, "um erro não pode ficar guardado por 120 s");
  });
});

describe("invalidarEntitlements", () => {
  test("apaga a chave daquele usuário, e só ela", async () => {
    const { cache, mapa, registro: reg } = cacheFalso({
      "entitlements:v1:user:u1": "qualquer coisa",
      "entitlements:v1:user:u2": "de outro usuário",
    });

    await invalidarEntitlements("u1", cache);

    assert.equal(reg.remocoes, 1);
    assert.equal(mapa.has("entitlements:v1:user:u1"), false);
    assert.equal(mapa.has("entitlements:v1:user:u2"), true);
  });

  test("depois de invalidar, a próxima resolução volta ao banco", async () => {
    const { cache } = cacheFalso();
    const primeira = fonteFalsa([assinatura()]);
    await entitlementsDoUsuario("u1", { fonte: primeira.fonte, cache, agora: AGORA });

    await invalidarEntitlements("u1", cache);

    const segunda = fonteFalsa([], planoPadraoRestrito());
    const r = await entitlementsDoUsuario("u1", { fonte: segunda.fonte, cache, agora: AGORA });

    assert.equal(segunda.registro.consultas, 1);
    assert.equal(r.assinatura.planoId, "gratuito");
  });
});

// ── A consulta ───────────────────────────────────────────────────────────────

/**
 * Interpreta os argumentos que o próprio código produz.
 *
 * Não reimplementa o filtro: lê `args.where`, aplica o que estiver lá, ordena e
 * corta. Se um campo da janela sumir de `argumentosDaConsulta`, este avaliador
 * deixa de filtrá-lo — e o cenário abaixo quebra, que é o objetivo.
 */
function consultarEmMemoria(
  linhas: AssinaturaCandidata[],
  args: ReturnType<typeof argumentosDaConsulta>,
): AssinaturaCandidata[] {
  const onde = args.where as unknown as Record<string, unknown>;

  const passa = (linha: AssinaturaCandidata) =>
    Object.entries(onde).every(([campo, condicao]) => {
      if (campo === "userId") return true; // o falso já é do usuário certo
      const valor = (linha as unknown as Record<string, unknown>)[campo];
      if (condicao && typeof condicao === "object" && !(condicao instanceof Date)) {
        const c = condicao as { lte?: Date; gt?: Date };
        const t = (valor as Date).getTime();
        if (c.lte !== undefined && !(t <= c.lte.getTime())) return false;
        if (c.gt !== undefined && !(t > c.gt.getTime())) return false;
        return true;
      }
      return valor === condicao;
    });

  return linhas
    .filter(passa)
    .sort((a, b) => b.terminaEm.getTime() - a.terminaEm.getTime())
    .slice(0, args.take);
}

describe("a consulta corta depois de filtrar a janela inteira", () => {
  test("o filtro carrega status, iniciaEm e terminaEm", () => {
    const args = argumentosDaConsulta("u1", AGORA);

    assert.equal(args.where.userId, "u1");
    assert.equal(args.where.status, "ATIVA");
    assert.deepEqual(args.where.iniciaEm, { lte: AGORA });
    assert.deepEqual(args.where.terminaEm, { gt: AGORA });
    assert.equal(args.take, 2);
  });

  /**
   * A regressão que motiva tudo isto.
   *
   * Sem `iniciaEm` no filtro, as duas futuras — que terminam mais tarde e
   * portanto vêm primeiro na ordenação — ocupariam as duas vagas do `take`, a
   * função pura descartaria as duas, e a assinatura que vale agora sumiria.
   * O usuário perderia o direito que pagou, sem erro aparente em lugar nenhum.
   */
  test("assinaturas futuras não escondem a que vale agora", () => {
    const daquiADias = (d: number) => new Date(AGORA.getTime() + d * 86_400_000);
    const linhas = [
      assinatura({ id: "futura-longa", iniciaEm: daquiADias(1), terminaEm: daquiADias(31) }),
      assinatura({ id: "futura-media", iniciaEm: daquiADias(2), terminaEm: daquiADias(22) }),
      assinatura({ id: "valida-agora", iniciaEm: emMinutos(-10), terminaEm: emMinutos(60) }),
    ];

    const trazidas = consultarEmMemoria(linhas, argumentosDaConsulta("u1", AGORA));

    assert.deepEqual(trazidas.map((l) => l.id), ["valida-agora"]);
  });

  test("com a janela filtrada, take:2 significa duas VÁLIDAS", () => {
    const linhas = [
      assinatura({ id: "futura", iniciaEm: emMinutos(60), terminaEm: emMinutos(9999) }),
      assinatura({ id: "valida-a", terminaEm: emMinutos(60) }),
      assinatura({ id: "valida-b", terminaEm: emMinutos(30) }),
    ];

    const trazidas = consultarEmMemoria(linhas, argumentosDaConsulta("u1", AGORA));

    assert.deepEqual(trazidas.map((l) => l.id).sort(), ["valida-a", "valida-b"]);
    // E o par trazido é o que a resolução usa para detectar a ambiguidade.
    assert.throws(
      () =>
        resolverEntitlements({
          agora: AGORA,
          candidatas: trazidas,
          planoPadrao: planoPadraoRestrito(),
        }),
      (e: unknown) =>
        e instanceof EntitlementsIndefinidos && e.motivo === "assinaturas_ambiguas",
    );
  });

  test("assinatura que termina exatamente agora não é trazida", () => {
    const linhas = [assinatura({ id: "no-limite", terminaEm: new Date(AGORA) })];
    assert.deepEqual(consultarEmMemoria(linhas, argumentosDaConsulta("u1", AGORA)), []);
  });

  test("assinatura que começa exatamente agora é trazida", () => {
    const linhas = [assinatura({ id: "estreando", iniciaEm: new Date(AGORA) })];
    assert.deepEqual(
      consultarEmMemoria(linhas, argumentosDaConsulta("u1", AGORA)).map((l) => l.id),
      ["estreando"],
    );
  });
});

// ── O cache não prolonga assinatura ──────────────────────────────────────────

describe("ttlDoCache: o cache não pode sobreviver ao vencimento", () => {
  const ativo = (expiraEm: Date | null): Entitlements => ({
    assinatura: { ativa: true, planoId: "plus", expiraEm },
    direitos: planoPago(),
  });
  const padrao: Entitlements = {
    assinatura: { ativa: false, planoId: "gratuito", expiraEm: null },
    direitos: planoPago(),
  };

  test("plano padrão não vence, então recebe os 120 s inteiros", () => {
    assert.equal(ttlDoCache(padrao, AGORA), TTL_ENTITLEMENTS_SEG);
  });

  test("assinatura com mais de 120 s restantes recebe 120", () => {
    assert.equal(ttlDoCache(ativo(emMinutos(60)), AGORA), 120);
  });

  test("assinatura com menos de 120 s restantes recebe o que falta", () => {
    const dez = new Date(AGORA.getTime() + 10_000);
    assert.equal(ttlDoCache(ativo(dez), AGORA), 10);
  });

  test("exatamente 120 s restantes continua 120", () => {
    assert.equal(ttlDoCache(ativo(new Date(AGORA.getTime() + 120_000)), AGORA), 120);
  });

  test("arredonda para baixo — nunca para cima", () => {
    // 10,9 s viram 10. Arredondar para cima faria a entrada sobreviver ao
    // vencimento pela fração descartada, que é exatamente o que se quer evitar.
    assert.equal(ttlDoCache(ativo(new Date(AGORA.getTime() + 10_900)), AGORA), 10);
  });

  test("sobrando menos de um segundo, não guarda", () => {
    assert.equal(ttlDoCache(ativo(new Date(AGORA.getTime() + 900)), AGORA), 0);
    assert.equal(ttlDoCache(ativo(new Date(AGORA)), AGORA), 0);
    assert.equal(ttlDoCache(ativo(new Date(AGORA.getTime() - 5_000)), AGORA), 0);
  });

  test("o TTL efetivo nunca ultrapassa o vencimento", () => {
    for (const restanteMs of [1, 999, 1_000, 59_999, 120_000, 3_600_000]) {
      const ent = ativo(new Date(AGORA.getTime() + restanteMs));
      const ttl = ttlDoCache(ent, AGORA);
      assert.ok(ttl * 1000 <= restanteMs, `TTL ${ttl}s passaria de ${restanteMs}ms`);
    }
  });
});

describe("cacheAindaVale: segunda camada, na leitura", () => {
  const comVencimento = (expiraEm: Date | null): Entitlements => ({
    assinatura: { ativa: true, planoId: "plus", expiraEm },
    direitos: planoPago(),
  });

  test("entrada de plano padrão vale sempre", () => {
    const padrao: Entitlements = {
      assinatura: { ativa: false, planoId: "gratuito", expiraEm: null },
      direitos: planoPago(),
    };
    assert.equal(cacheAindaVale(padrao, AGORA), true);
  });

  test("assinatura ainda dentro da janela vale", () => {
    assert.equal(cacheAindaVale(comVencimento(emMinutos(1)), AGORA), true);
  });

  test("vencida não vale, mesmo íntegra", () => {
    assert.equal(cacheAindaVale(comVencimento(emMinutos(-1)), AGORA), false);
  });

  test("vencendo exatamente agora não vale — mesma convenção da janela", () => {
    assert.equal(cacheAindaVale(comVencimento(new Date(AGORA)), AGORA), false);
  });
});

describe("entitlementsDoUsuario: cache vencido não autoriza", () => {
  test("entrada ativa com expiraEm no passado é ignorada e força consulta", async () => {
    // Gravada quando a assinatura ainda valia; lida depois do vencimento.
    const gravadaAntes = new Date(AGORA.getTime() - 60_000);
    const { cache } = cacheFalso();
    const antiga = fonteFalsa([
      assinatura({ terminaEm: new Date(AGORA.getTime() - 10_000) }),
    ]);
    await entitlementsDoUsuario("u1", { fonte: antiga.fonte, cache, agora: gravadaAntes });

    // Agora a assinatura já venceu, e o Postgres não traz mais nenhuma válida.
    const depois = fonteFalsa([]);
    const r = await entitlementsDoUsuario("u1", { fonte: depois.fonte, cache, agora: AGORA });

    assert.equal(depois.registro.consultas, 1, "deveria ter voltado ao Postgres");
    assert.equal(r.assinatura.ativa, false);
    assert.equal(r.assinatura.planoId, "gratuito");
  });

  test("o cache nunca devolve ativa=true depois de terminaEm", async () => {
    const venceEm = new Date(AGORA.getTime() + 30_000);
    const { cache } = cacheFalso();
    const antes = fonteFalsa([assinatura({ terminaEm: venceEm })]);

    const durante = await entitlementsDoUsuario("u1", { fonte: antes.fonte, cache, agora: AGORA });
    assert.equal(durante.assinatura.ativa, true);

    // Um instante depois do vencimento, com a entrada ainda no Redis.
    const depoisDoVencimento = new Date(venceEm.getTime() + 1);
    const semAssinatura = fonteFalsa([]);
    const r = await entitlementsDoUsuario("u1", {
      fonte: semAssinatura.fonte,
      cache,
      agora: depoisDoVencimento,
    });

    assert.equal(r.assinatura.ativa, false);
    assert.equal(r.direitos.downloads, false);
  });

  test("entrada vencida é substituída por uma válida", async () => {
    const { cache, mapa } = cacheFalso();
    const antes = fonteFalsa([assinatura({ terminaEm: new Date(AGORA.getTime() + 30_000) })]);
    await entitlementsDoUsuario("u1", { fonte: antes.fonte, cache, agora: AGORA });

    const depois = new Date(AGORA.getTime() + 60_000);
    await entitlementsDoUsuario("u1", { fonte: fonteFalsa([]).fonte, cache, agora: depois });

    const guardado = reviverEntitlements(mapa.get("entitlements:v1:user:u1")!);
    assert.equal(guardado?.assinatura.ativa, false);
  });

  test("assinatura curta é gravada com TTL limitado, não com 120", async () => {
    const { cache, registro: reg } = cacheFalso();
    const { fonte } = fonteFalsa([
      assinatura({ terminaEm: new Date(AGORA.getTime() + 10_000) }),
    ]);

    await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });

    assert.deepEqual(reg.ttls, [10]);
  });

  test("assinatura longa é gravada com os 120 s", async () => {
    const { cache, registro: reg } = cacheFalso();
    const { fonte } = fonteFalsa([assinatura({ terminaEm: emMinutos(60) })]);

    await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });

    assert.deepEqual(reg.ttls, [TTL_ENTITLEMENTS_SEG]);
  });

  test("plano padrão continua com os 120 s", async () => {
    const { cache, registro: reg } = cacheFalso();
    const { fonte } = fonteFalsa([]);

    await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });

    assert.deepEqual(reg.ttls, [TTL_ENTITLEMENTS_SEG]);
  });

  test("sobrando menos de um segundo, não grava — e responde certo", async () => {
    const { cache, registro: reg, mapa } = cacheFalso();
    const { fonte } = fonteFalsa([
      assinatura({ terminaEm: new Date(AGORA.getTime() + 500) }),
    ]);

    const r = await entitlementsDoUsuario("u1", { fonte, cache, agora: AGORA });

    assert.equal(r.assinatura.ativa, true, "ainda vale neste instante");
    assert.equal(reg.gravacoes, 0, "não vale a pena guardar por menos de 1 s");
    assert.equal(mapa.size, 0);
  });
});
