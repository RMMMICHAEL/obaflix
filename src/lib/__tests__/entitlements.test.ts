import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  EntitlementsIndefinidos,
  TTL_ENTITLEMENTS_SEG,
  assinaturaValida,
  chaveEntitlements,
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
