import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { POST as authorizePost } from "@/app/api/playback/authorize/route";
import { POST as completePost } from "@/app/api/ads/complete/route";
import { autorizarPorAnuncio } from "../ads/enforcement";
import {
  TEMPO_MINIMO_DE_ANUNCIO_MS,
  TTL_PASSE_S,
  abrirDesafio,
  consumirConcessao,
  emitirConcessao,
  estaPago,
  registrarEpisodioDistinto,
  type AlvoDeConcessao,
  type FinalidadeDeConcessao,
} from "../ads/concessoes";
import { resolverDirectLink } from "../ads/directLink";
import { PLANO_BASIC, PLANO_GRATUITO, PLANO_PREMIUM } from "../planos";
import { getRedis } from "../redis";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * A sequência inteira, ponta a ponta, pelas **rotas reais**.
 *
 * Os testes anteriores exercitam peças: a política pura, o estado no Redis, o
 * enforcement, o fluxo do cliente. Este exercita a corrente — `/authorize` →
 * `/ads/complete` → o portão de `/fontes` — porque é a corrente que pode estar
 * errada mesmo com todos os elos certos. Foi exatamente esse o defeito que o
 * smoke test encontrou: `/authorize` dizia PERMITIDO para o episódio que não
 * devia anúncio, e `/fontes` recusava por falta de concessão.
 *
 * Redis é o `MemoryStore` de verdade (o mesmo cliente que roda fora de
 * produção). Sessão, entitlements e bloqueio de IP entram por injeção — são o
 * que não dá para ter aqui, não o que está sendo testado.
 */

// ── Montagem ─────────────────────────────────────────────────────────────────

function direitosDe(plano: PlanoSemeado): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return direitos as DireitosDoPlano;
}

function entitlementsDe(plano: PlanoSemeado): Entitlements {
  return {
    assinatura: { ativa: true, planoId: plano.id, expiraEm: null },
    direitos: direitosDe(plano),
  };
}

let sequencia = 0;
const novoUsuario = () => `u_int_${Date.now()}_${++sequencia}`;

const req = (corpo: unknown) =>
  new Request("https://obaflix.test/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  }) as unknown as Parameters<ReturnType<typeof createAuthorizeHandler>>[0];

/** As portas que não são o objeto do teste. Redis e política ficam reais. */
function portasComuns(userId: string, plano: PlanoSemeado) {
  return {
    getUserFromRequest: async () => ({
      userId,
      role: "user",
      origem: "cookie" as const,
      deviceId: null,
    }),
    monetizacaoAtiva: () => true,
    entitlementsDoUsuario: async () => entitlementsDe(plano),
    isIpBlocked: async () => false,
    recordAbuseAttempt: async () => {},
  };
}

const createAuthorizeHandler = authorizePost.createForTest;
const createAdsCompleteHandler = completePost.createForTest;

function autorizador(
  userId: string,
  plano: PlanoSemeado,
  env: Record<string, string | undefined> = {},
) {
  return createAuthorizeHandler({
    ...portasComuns(userId, plano),
    resolverDirectLink: () => resolverDirectLink(env),
  });
}

/** `/ads/complete` com o relógio adiantado: o tempo mínimo é real, a espera não. */
function concluidor(userId: string, plano: PlanoSemeado, avancoMs = TEMPO_MINIMO_DE_ANUNCIO_MS + 500) {
  return createAdsCompleteHandler({
    ...portasComuns(userId, plano),
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    agora: () => Date.now() + avancoMs,
  });
}

const ALVO_F1: AlvoDeConcessao = { tipo: "filme", conteudoId: "f1", temporada: null, episodio: null };
const alvoEp = (temporada: number, episodio: number): AlvoDeConcessao => ({
  tipo: "serie",
  conteudoId: "s1",
  temporada,
  episodio,
});

/** O portão de `/fontes`, com Redis real e entitlements injetados. */
const portaDeFontes = (
  userId: string,
  plano: PlanoSemeado,
  concessao: string | null,
  alvo: AlvoDeConcessao = ALVO_F1,
  finalidade: FinalidadeDeConcessao = "reproducao",
) =>
  autorizarPorAnuncio(
    { userId, tipo: alvo.tipo, concessao, finalidade, alvo },
    { ativa: true, resolver: async () => entitlementsDe(plano) },
  );

const DL_VALIDO = { ANUNCIO_DIRECT_LINK_URL: "https://rede.invalido/x?p=1" };

/** Pede autorização e, se o servidor exigir anúncio, conclui e devolve a concessão. */
async function liberar(
  userId: string,
  corpo: Record<string, unknown>,
  plano: PlanoSemeado = PLANO_GRATUITO,
): Promise<{ decisao: string; id: string | null }> {
  const auth = await (await autorizador(userId, plano, DL_VALIDO)(req(corpo))).json();
  if (auth.decisao === "ANUNCIO_NECESSARIO") {
    const { concessao } = await (await concluidor(userId, plano)(req({ desafioId: auth.desafioId }))).json();
    return { decisao: auth.decisao, id: concessao };
  }
  return { decisao: auth.decisao, id: typeof auth.passe === "string" ? auth.passe : null };
}

// ── 1 a 4. Electron ──────────────────────────────────────────────────────────

describe("Electron", () => {
  /** Cenário 1: o caminho feliz completo, do pedido à sessão liberada. */
  test("gratuito com Direct Link: anúncio → desafio → concessão → /fontes aceita", async () => {
    const userId = novoUsuario();

    const r1 = await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
      req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "electron" }),
    );
    const auth = await r1.json();

    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    assert.equal(typeof auth.desafioId, "string");
    assert.equal(auth.directLink, DL_VALIDO.ANUNCIO_DIRECT_LINK_URL);
    assert.equal(r1.headers.get("Cache-Control")?.includes("no-store"), true);

    const r2 = await concluidor(userId, PLANO_GRATUITO)(req({ desafioId: auth.desafioId }));
    const { concessao } = await r2.json();
    assert.equal(typeof concessao, "string");

    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, concessao), {
      liberado: true,
      via: "concessao",
    });
  });

  /**
   * Cenário 2 — sem Direct Link, `/authorize` e `/fontes` dizem a mesma coisa,
   * e o cliente sabe que não deve nem tentar abrir a sessão.
   */
  test("gratuito SEM Direct Link: ANUNCIO_INDISPONIVEL, e /fontes recusaria", async () => {
    const userId = novoUsuario();

    const r = await autorizador(userId, PLANO_GRATUITO, {})(
      req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "electron" }),
    );
    const auth = await r.json();

    assert.equal(auth.decisao, "ANUNCIO_INDISPONIVEL");
    assert.equal(auth.desafioId, undefined, "não se emite desafio que ninguém pode cumprir");
    assert.equal(auth.directLink, undefined);

    // Coerência: se o cliente insistisse, a autoridade final também recusaria.
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, null), {
      liberado: false,
      motivo: "sem_concessao",
    });
  });

  /** Cenário 3: link inválido é indistinguível de ausente, e é o certo. */
  test("gratuito com Direct Link inválido: mesmo comportamento", async () => {
    for (const url of ["http://inseguro.invalido", "javascript:alert(1)", "nao-e-url", "   "]) {
      const userId = novoUsuario();
      const r = await autorizador(userId, PLANO_GRATUITO, { ANUNCIO_DIRECT_LINK_URL: url })(
        req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "electron" }),
      );
      const auth = await r.json();
      assert.equal(auth.decisao, "ANUNCIO_INDISPONIVEL", url);
      assert.equal(auth.directLink, undefined, url);
    }
  });

  /** Cenário 4 e 17. */
  test("assinante: PERMITIDO, sem Direct Link, e /fontes aceita sem concessão", async () => {
    for (const plano of [PLANO_BASIC, PLANO_PREMIUM]) {
      const userId = novoUsuario();
      const r = await autorizador(userId, plano, DL_VALIDO)(
        req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "electron" }),
      );
      const auth = await r.json();

      assert.equal(auth.decisao, "PERMITIDO", plano.id);
      assert.equal(auth.directLink, undefined, `${plano.id} não pode receber o Direct Link`);
      assert.equal(auth.desafioId, undefined);
      assert.equal(auth.passe, undefined, "quem não vê anúncio não precisa de passe");
      assert.equal(JSON.stringify(auth).includes("rede.invalido"), false);

      assert.deepEqual(await portaDeFontes(userId, plano, null), {
        liberado: true,
        via: "sem_anuncios",
      });
    }
  });
});

// ── 5 e 6. Android ───────────────────────────────────────────────────────────

describe("Android", () => {
  /** Cenário 5. */
  test("gratuito: anúncio → concessão → /fontes aceita, sem Direct Link", async () => {
    const userId = novoUsuario();

    const r1 = await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
      req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "android" }),
    );
    const auth = await r1.json();

    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    assert.equal(
      auth.directLink,
      undefined,
      "o Direct Link é do Electron; o Android não tem o que fazer com ele",
    );

    const r2 = await concluidor(userId, PLANO_GRATUITO)(req({ desafioId: auth.desafioId }));
    const { concessao } = await r2.json();

    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, concessao), {
      liberado: true,
      via: "concessao",
    });
  });

  /** Cenário 6: sem desafio, o cliente não tem o que pedir ao SDK. */
  test("assinante: PERMITIDO e nenhum desafio — o SDK nunca é acionado", async () => {
    const userId = novoUsuario();
    const r = await autorizador(userId, PLANO_PREMIUM, DL_VALIDO)(
      req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "android" }),
    );
    const auth = await r.json();

    assert.equal(auth.decisao, "PERMITIDO");
    assert.equal(auth.desafioId, undefined);
  });
});

// ── 7 a 11. A concessão ──────────────────────────────────────────────────────

describe("concessão: uso único, dono, finalidade, validade", () => {
  /** Cenário 7. */
  test("usada duas vezes: só a primeira funciona", async () => {
    const userId = novoUsuario();
    const concessao = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao)).liberado, true);
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, concessao), {
      liberado: false,
      motivo: "concessao_invalida",
    });
  });

  /** Cenário 8 — o `DEL` é quem autoriza, e por isso exatamente uma passa. */
  test("três requisições paralelas: exatamente uma funciona", async () => {
    const userId = novoUsuario();
    const concessao = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    const resultados = await Promise.all([
      portaDeFontes(userId, PLANO_GRATUITO, concessao),
      portaDeFontes(userId, PLANO_GRATUITO, concessao),
      portaDeFontes(userId, PLANO_GRATUITO, concessao),
    ]);

    assert.equal(resultados.filter((r) => r.liberado).length, 1);
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, concessao), {
      liberado: false,
      motivo: "concessao_invalida",
    }, "depois do único vencedor, toda tentativa posterior é recusada");
  });

  /** Cenário 9. */
  test("concessão de outro usuário é negada", async () => {
    const dono = novoUsuario();
    const intruso = novoUsuario();
    const concessao = await emitirConcessao({ userId: dono, finalidade: "reproducao", verificacao: "soft" });

    assert.equal((await portaDeFontes(intruso, PLANO_GRATUITO, concessao)).liberado, false);
    // A prova importante não é só o GET: o dono ainda consegue consumi-la.
    assert.equal((await portaDeFontes(dono, PLANO_GRATUITO, concessao)).liberado, true);
  });

  /** Cenário 10. */
  test("finalidade errada é negada", async () => {
    const userId = novoUsuario();
    const concessao = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });

    assert.equal(
      await consumirConcessao(concessao, userId, "canais" as unknown as "reproducao"),
      false,
    );
    // Finalidade inválida tampouco pode queimar a concessão legítima.
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao)).liberado, true);
  });

  /** Cenário 11: expirada é o mesmo que inexistente. */
  test("concessão expirada é negada", async () => {
    const userId = novoUsuario();
    const concessao = await emitirConcessao({ userId, finalidade: "reproducao", verificacao: "soft" });
    await getRedis().del(`ads:concessao:${concessao}`);

    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, concessao), {
      liberado: false,
      motivo: "concessao_invalida",
    });
  });

  /**
   * O tempo mínimo é medido pelo **nosso** relógio, contra o `criadoEm` que o
   * servidor gravou. Uma conclusão instantânea é automação, não anúncio.
   */
  test("conclusão rápida demais não emite concessão", async () => {
    const userId = novoUsuario();
    const r1 = await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
      req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "electron" }),
    );
    const { desafioId } = await r1.json();

    // Sem avançar o relógio.
    const r2 = await concluidor(userId, PLANO_GRATUITO, 0)(req({ desafioId }));

    assert.equal(r2.status, 403);
    const corpo = await r2.json();
    assert.equal(corpo.concessao, undefined);
  });

  test("desafio reutilizado não emite segunda concessão", async () => {
    const userId = novoUsuario();
    const desafioId = await abrirDesafio({ userId, tipo: "filme", plataforma: "android" });

    const primeiro = await concluidor(userId, PLANO_GRATUITO)(req({ desafioId }));
    assert.equal((await primeiro.json()).concessao !== undefined, true);

    const segundo = await concluidor(userId, PLANO_GRATUITO)(req({ desafioId }));
    assert.equal(segundo.status, 403);
  });

  test("desafio de outra conta não é aceito", async () => {
    const dono = novoUsuario();
    const intruso = novoUsuario();
    const desafioId = await abrirDesafio({ userId: dono, tipo: "filme", plataforma: "android" });

    const r = await concluidor(intruso, PLANO_GRATUITO)(req({ desafioId }));
    assert.equal(r.status, 403);
  });
});

// ── 12. Fail-closed ──────────────────────────────────────────────────────────

describe("fail-closed", () => {
  /** Cenário 12, nas duas pontas. */
  test("entitlements indisponíveis: 503 no authorize, recusa no portão", async () => {
    const userId = novoUsuario();

    const handler = createAuthorizeHandler({
      ...portasComuns(userId, PLANO_GRATUITO),
      entitlementsDoUsuario: async () => {
        throw new Error("Redis e Postgres fora");
      },
    });

    const r = await handler(req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "android" }));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).codigo, "entitlements_indisponiveis");

    const portao = await autorizarPorAnuncio(
      { userId, tipo: "filme", concessao: "qualquer" },
      { ativa: true, resolver: async () => { throw new Error("fora"); } },
    );
    assert.deepEqual(portao, { liberado: false, motivo: "indeterminado" });
  });

  test("contador indisponível vira 503, não liberação", async () => {
    const userId = novoUsuario();
    const handler = createAuthorizeHandler({
      ...portasComuns(userId, PLANO_GRATUITO),
      registrarEpisodioDistinto: async () => {
        throw new Error("Redis fora");
      },
    });

    const r = await handler(
      req({ conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1, plataforma: "android" }),
    );
    assert.equal(r.status, 503);
  });

  /**
   * Sem passe o episódio seria recusado em `/fontes`. Responder PERMITIDO sem
   * ele recriaria exatamente a divergência corrigida — então é 503.
   */
  test("passe indisponível vira 503, não PERMITIDO sem prova", async () => {
    const userId = novoUsuario();
    const handler = createAuthorizeHandler({
      ...portasComuns(userId, PLANO_GRATUITO),
      emitirPasse: async () => {
        throw new Error("Redis fora");
      },
    });

    const r = await handler(
      req({ conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1, plataforma: "android" }),
    );
    assert.equal(r.status, 503);
  });
});

// ── 13 a 16. Séries ──────────────────────────────────────────────────────────

describe("séries, pela rota", () => {
  const pedirEpisodio = (userId: string, temporada: number, numeroEp: number, finalidade?: string) =>
    autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
      req({ conteudoId: "s1", conteudoTipo: "serie", temporada, numeroEp, plataforma: "android", finalidade }),
    ).then((r) => r.json());

  /** Cenário 13: o terceiro episódio distinto paga; os dois primeiros levam passe. */
  test("1 livre, 2 livre, 3 exige anúncio", async () => {
    const userId = novoUsuario();

    const ep1 = await pedirEpisodio(userId, 1, 1);
    const ep2 = await pedirEpisodio(userId, 1, 2);
    const ep3 = await pedirEpisodio(userId, 1, 3);

    assert.equal(ep1.decisao, "PERMITIDO");
    assert.equal(typeof ep1.passe, "string", "episódio dentro da cota leva a prova para /fontes");
    assert.equal(ep2.decisao, "PERMITIDO");
    assert.equal(typeof ep2.passe, "string");
    assert.equal(ep3.decisao, "ANUNCIO_NECESSARIO");
    assert.equal(ep3.passe, undefined, "o episódio que paga não recebe passe");
  });

  /** Cenários 14 e 15: replay e retry são o mesmo episódio de novo. */
  test("replay e retry não incrementam", async () => {
    const userId = novoUsuario();

    await pedirEpisodio(userId, 1, 1);
    await pedirEpisodio(userId, 1, 1); // replay
    await pedirEpisodio(userId, 1, 1); // retry do player
    await pedirEpisodio(userId, 1, 2);
    await pedirEpisodio(userId, 1, 2); // retry
    // Só dois distintos até aqui: o terceiro distinto é que paga.
    assert.equal((await pedirEpisodio(userId, 1, 3)).decisao, "ANUNCIO_NECESSARIO");
  });

  /**
   * Concorrência: dois pedidos simultâneos do **mesmo** episódio não podem
   * contar duas vezes. É o `SET NX` que garante — só um deles cria a chave.
   */
  test("pedidos paralelos do mesmo episódio contam uma vez", async () => {
    const userId = novoUsuario();

    await Promise.all([
      registrarEpisodioDistinto({ userId, conteudoId: "s1", temporada: 1, episodio: 1, direitos: direitosDe(PLANO_GRATUITO) }),
      registrarEpisodioDistinto({ userId, conteudoId: "s1", temporada: 1, episodio: 1, direitos: direitosDe(PLANO_GRATUITO) }),
      registrarEpisodioDistinto({ userId, conteudoId: "s1", temporada: 1, episodio: 1, direitos: direitosDe(PLANO_GRATUITO) }),
    ]);

    const total = await registrarEpisodioDistinto({
      userId, conteudoId: "s1", temporada: 1, episodio: 2, direitos: direitosDe(PLANO_GRATUITO),
    });
    assert.equal(total, 2, "o episódio 1 não pode ter contado três vezes");
  });

  /** Cenário 16: vencida a janela, o ciclo recomeça. */
  test("janela expirada reinicia o ciclo", async () => {
    const userId = novoUsuario();
    await pedirEpisodio(userId, 1, 1);
    await pedirEpisodio(userId, 1, 2);

    // O que o Redis faz no vencimento do TTL.
    const redis = getRedis();
    await redis.del(`ads:ep:contador:${userId}`);
    for (const ep of [1, 2]) {
      const { chaveDoEpisodio } = await import("../ads/concessoes");
      await redis.del(`ads:ep:visto:${userId}:${chaveDoEpisodio(userId, "s1", 1, ep)}`);
    }

    // Janela nova: o antigo episódio 1 volta a ser o primeiro do ciclo.
    assert.equal((await pedirEpisodio(userId, 1, 1)).decisao, "PERMITIDO");
    assert.equal((await pedirEpisodio(userId, 1, 2)).decisao, "PERMITIDO");
    assert.equal((await pedirEpisodio(userId, 1, 3)).decisao, "ANUNCIO_NECESSARIO");
  });

  /** Depois do anúncio, a concessão cobre o episódio que pagou e o ciclo segue. */
  test("com concessão, o episódio que pagaria é liberado", async () => {
    const userId = novoUsuario();
    await pedirEpisodio(userId, 1, 1);
    await pedirEpisodio(userId, 1, 2);

    const auth = await pedirEpisodio(userId, 1, 3);
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");

    const r = await concluidor(userId, PLANO_GRATUITO)(req({ desafioId: auth.desafioId }));
    const { concessao } = await r.json();

    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, concessao, alvoEp(1, 3)), {
      liberado: true,
      via: "concessao",
    });
    // A concessão foi consumida; o quarto distinto inicia o próximo grupo.
    assert.equal((await pedirEpisodio(userId, 1, 4)).decisao, "PERMITIDO");
  });
});

// ── O defeito do smoke test: trocar de episódio ──────────────────────────────

describe("passe de cota: o episódio que não deve anúncio abre /fontes", () => {
  /**
   * O teste explícito pedido: a política deixa passar, o servidor emite o
   * passe, e a sessão de fontes abre com ele. Antes, este caminho terminava em
   * "não foi possível carregar os servidores".
   */
  test("série: episódio autorizado sem novo anúncio → /fontes aceita o passe → sessão abre", async () => {
    const userId = novoUsuario();

    const auth = await (await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
      req({ conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1, plataforma: "android" }),
    )).json();

    assert.equal(auth.decisao, "PERMITIDO");
    assert.equal(auth.desafioId, undefined, "nenhum anúncio foi pedido");
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, auth.passe, alvoEp(1, 1)), {
      liberado: true,
      via: "concessao",
    });
  });

  test("trocar de episódio volta a abrir a sessão; o 3º continua exigindo anúncio", async () => {
    const userId = novoUsuario();

    // Episódio 3 pago primeiro, como no smoke test: anúncio, concessão, sessão.
    await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1, plataforma: "android" });
    await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 2, plataforma: "android" });
    const ep3 = await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 3, plataforma: "android" });
    assert.equal(ep3.decisao, "ANUNCIO_NECESSARIO");
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, ep3.id, alvoEp(1, 3))).liberado, true);

    // Troca para o 4º: dentro da cota do novo ciclo, com passe, e a sessão abre.
    const ep4 = await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 4, plataforma: "android" });
    assert.equal(ep4.decisao, "PERMITIDO");
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, ep4.id, alvoEp(1, 4))).liberado, true);

    const ep5 = await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 5, plataforma: "android" });
    assert.equal(ep5.decisao, "PERMITIDO");
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, ep5.id, alvoEp(1, 5))).liberado, true);

    // O 6º distinto volta a pagar: a política de N episódios continua valendo.
    const ep6 = await (await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
      req({ conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 6, plataforma: "android" }),
    )).json();
    assert.equal(ep6.decisao, "ANUNCIO_NECESSARIO");
  });

  test("o passe do 1º episódio não abre o 3º, e a tentativa não o queima", async () => {
    const userId = novoUsuario();
    const ep1 = await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1, plataforma: "android" });

    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, ep1.id, alvoEp(1, 3)), {
      liberado: false,
      motivo: "concessao_invalida",
    });
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, ep1.id, alvoEp(1, 1))).liberado, true);
  });

  test("o passe é de uso único e curto", async () => {
    const userId = novoUsuario();
    const ep1 = await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1, plataforma: "android" });

    const ttl = await getRedis().ttl(`ads:concessao:${ep1.id}`);
    assert.ok(ttl > 0 && ttl <= TTL_PASSE_S, `ttl do passe fora do limite: ${ttl}`);

    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, ep1.id, alvoEp(1, 1))).liberado, true);
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, ep1.id, alvoEp(1, 1)), {
      liberado: false,
      motivo: "concessao_invalida",
    });
  });

  /**
   * Retry, sessão expirada ou voltar ao episódio que pagou: passe sem outro
   * anúncio, e o contador não soma o mesmo episódio de novo.
   */
  test("reabrir o 3º episódio depois do anúncio: passe, sem novo anúncio e sem somar", async () => {
    const userId = novoUsuario();
    await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1, plataforma: "android" });
    await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 2, plataforma: "android" });
    const pago = await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 3, plataforma: "android" });
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, pago.id, alvoEp(1, 3))).liberado, true);

    for (let i = 0; i < 3; i++) {
      const reaberto = await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 3, plataforma: "android" });
      assert.equal(reaberto.decisao, "PERMITIDO", `reabertura ${i + 1} não pode pedir anúncio`);
      assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, reaberto.id, alvoEp(1, 3))).liberado, true);
    }

    // Se o 3º tivesse somado de novo, o 4º cairia no 6 e pagaria.
    assert.equal(
      (await liberar(userId, { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 4, plataforma: "android" })).decisao,
      "PERMITIDO",
    );
  });

  test("filme: sessão expirada depois do anúncio reabre com passe; outro filme ainda paga", async () => {
    const userId = novoUsuario();
    const primeiro = await liberar(userId, { conteudoId: "f1", conteudoTipo: "filme", plataforma: "android" });
    assert.equal(primeiro.decisao, "ANUNCIO_NECESSARIO");
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, primeiro.id)).liberado, true);
    assert.equal(await estaPago({ userId, finalidade: "reproducao", alvo: ALVO_F1 }), true);

    const reaberto = await liberar(userId, { conteudoId: "f1", conteudoTipo: "filme", plataforma: "android" });
    assert.equal(reaberto.decisao, "PERMITIDO");
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, reaberto.id)).liberado, true);

    const outro = await (await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
      req({ conteudoId: "f2", conteudoTipo: "filme", plataforma: "android" }),
    )).json();
    assert.equal(outro.decisao, "ANUNCIO_NECESSARIO", "o anúncio de um filme não paga outro");
  });
});

// ── Reprodução, download e transmissão ───────────────────────────────────────

describe("finalidade: reprodução, download e transmissão separados", () => {
  const FILME = { conteudoId: "f1", conteudoTipo: "filme", plataforma: "android" };

  test("download grátis exige anúncio mesmo dentro da cota, e não conta episódio", async () => {
    const userId = novoUsuario();

    // Baixar dois episódios distintos: anúncio em cada, e nenhum entra na cota.
    for (const numeroEp of [5, 6]) {
      const d = await (await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
        req({ conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp, plataforma: "android", finalidade: "download" }),
      )).json();
      assert.equal(d.decisao, "ANUNCIO_NECESSARIO", `download do episódio ${numeroEp}`);
    }

    // Se tivessem contado, o 1º episódio assistido já seria o 3º distinto e pagaria.
    const serie = { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, plataforma: "android" };
    assert.equal((await liberar(userId, { ...serie, numeroEp: 1 })).decisao, "PERMITIDO");
    assert.equal((await liberar(userId, { ...serie, numeroEp: 2 })).decisao, "PERMITIDO");
    assert.equal((await liberar(userId, { ...serie, numeroEp: 3 })).decisao, "ANUNCIO_NECESSARIO");
  });

  test("transmissão grátis exige anúncio", async () => {
    const userId = novoUsuario();
    const t = await (await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
      req({ ...FILME, finalidade: "transmissao" }),
    )).json();
    assert.equal(t.decisao, "ANUNCIO_NECESSARIO");
  });

  test("cada concessão abre só a própria finalidade", async () => {
    const casos: FinalidadeDeConcessao[] = ["reproducao", "download", "transmissao"];
    for (const emitida of casos) {
      for (const pedida of casos) {
        const userId = novoUsuario();
        const { id } = await liberar(userId, { ...FILME, finalidade: emitida });
        const r = await portaDeFontes(userId, PLANO_GRATUITO, id, ALVO_F1, pedida);
        assert.equal(r.liberado, emitida === pedida, `concessão de ${emitida} pedida para ${pedida}`);
      }
    }
  });

  test("download e transmissão depois do anúncio não ficam pagos: nova ação, novo anúncio", async () => {
    for (const finalidade of ["download", "transmissao"] as const) {
      const userId = novoUsuario();
      const primeira = await liberar(userId, { ...FILME, finalidade });
      assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, primeira.id, ALVO_F1, finalidade)).liberado, true);
      assert.equal(await estaPago({ userId, finalidade, alvo: ALVO_F1 }), false);

      const segunda = await (await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
        req({ ...FILME, finalidade }),
      )).json();
      assert.equal(segunda.decisao, "ANUNCIO_NECESSARIO", finalidade);
    }
  });

  test("anúncio de download não libera a reprodução do mesmo filme", async () => {
    const userId = novoUsuario();
    await liberar(userId, { ...FILME, finalidade: "download" });
    const r = await (await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(req(FILME))).json();
    assert.equal(r.decisao, "ANUNCIO_NECESSARIO");
  });

  test("finalidade desconhecida é pedido inválido, não reprodução", async () => {
    const userId = novoUsuario();
    for (const finalidade of ["canais", "", 7, {}]) {
      const r = await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(req({ ...FILME, finalidade }));
      assert.equal(r.status, 400, JSON.stringify(finalidade));
    }
  });

  test("assinante: PERMITIDO sem modal nem passe nas três finalidades, e /fontes libera", async () => {
    for (const plano of [PLANO_BASIC, PLANO_PREMIUM]) {
      for (const finalidade of ["reproducao", "download", "transmissao"] as const) {
        const userId = novoUsuario();
        const r = await (await autorizador(userId, plano, DL_VALIDO)(req({ ...FILME, finalidade }))).json();
        assert.equal(r.decisao, "PERMITIDO", `${plano.id} ${finalidade}`);
        assert.equal(r.desafioId, undefined);
        assert.equal(r.passe, undefined);
        assert.deepEqual(await portaDeFontes(userId, plano, null, ALVO_F1, finalidade), {
          liberado: true,
          via: "sem_anuncios",
        });
      }
    }
  });
});

// ── 19 e 20. Flag desligada e política de plataforma ─────────────────────────

describe("flag desligada preserva o comportamento antigo", () => {
  /** Cenário 19: nada é consultado, nada é criado. */
  test("authorize responde PERMITIDO sem tocar em entitlements nem Redis", async () => {
    const userId = novoUsuario();
    let consultou = 0;
    let registrou = 0;

    const handler = createAuthorizeHandler({
      ...portasComuns(userId, PLANO_GRATUITO),
      monetizacaoAtiva: () => false,
      entitlementsDoUsuario: async () => {
        consultou++;
        return entitlementsDe(PLANO_GRATUITO);
      },
      registrarEpisodioDistinto: async () => {
        registrou++;
        return 1;
      },
    });

    const r = await handler(
      req({ conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 9, plataforma: "android" }),
    );

    assert.equal((await r.json()).decisao, "PERMITIDO");
    assert.equal(consultou, 0, "com a flag off nada pode ser consultado");
    assert.equal(registrou, 0, "nem o contador de episódios");
  });

  /** E o portão de `/fontes` também não cobra nada. */
  test("o portão libera sem concessão", async () => {
    const userId = novoUsuario();
    const r = await autorizarPorAnuncio(
      { userId, tipo: "filme", concessao: null },
      { ativa: false, resolver: async () => entitlementsDe(PLANO_GRATUITO) },
    );
    assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
  });

  /** `/ads/complete` fecha: não se pré-fabrica concessão antes de ligar. */
  test("complete responde 404 com a flag desligada", async () => {
    const userId = novoUsuario();
    const handler = createAdsCompleteHandler({
      ...portasComuns(userId, PLANO_GRATUITO),
      monetizacaoAtiva: () => false,
      checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    });

    const r = await handler(req({ desafioId: "qualquer" }));
    assert.equal(r.status, 404);
  });
});

describe("política de plataforma: o cliente não escapa declarando ambiente", () => {
  /**
   * Cenário 20, e a propriedade que sustenta a política inteira:
   *
   * **nenhum valor de plataforma produz PERMITIDO para uma conta que deve
   * anúncio.** Declarar `web`, omitir o campo ou inventar um valor leva a
   * `ANUNCIO_INDISPONIVEL` — mais restritivo, nunca mais permissivo. É o que
   * impede o `ambiente` declarado pelo cliente de virar caminho de fuga.
   */
  test("web, ausente ou inventada: ANUNCIO_INDISPONIVEL, nunca PERMITIDO", async () => {
    for (const plataforma of ["web", undefined, null, "tv", "ios", 42, {}]) {
      const userId = novoUsuario();
      const r = await autorizador(userId, PLANO_GRATUITO, DL_VALIDO)(
        req({ conteudoId: "f1", conteudoTipo: "filme", plataforma }),
      );
      const auth = await r.json();

      assert.equal(
        auth.decisao,
        "ANUNCIO_INDISPONIVEL",
        `plataforma=${JSON.stringify(plataforma)} não pode liberar`,
      );
      assert.notEqual(auth.decisao, "PERMITIDO");
      assert.equal(auth.directLink, undefined);
    }
  });

  /** Assinante passa em qualquer plataforma — o direito é que decide. */
  test("assinante é PERMITIDO mesmo em plataforma sem meio de exibição", async () => {
    const userId = novoUsuario();
    const r = await autorizador(userId, PLANO_PREMIUM, {})(
      req({ conteudoId: "f1", conteudoTipo: "filme", plataforma: "web" }),
    );
    assert.equal((await r.json()).decisao, "PERMITIDO");
  });

  /** E a autoridade final concorda: sem concessão, a sessão não nasce. */
  test("o portão de /fontes recusa o gratuito em qualquer plataforma", async () => {
    const userId = novoUsuario();
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, null)).liberado, false);
  });
});
