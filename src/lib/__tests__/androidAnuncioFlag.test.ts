import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { POST as authorizePost } from "@/app/api/playback/authorize/route";
import { POST as completePost } from "@/app/api/ads/complete/route";
import { POST as iniciarPost } from "@/app/api/ads/promocao/iniciar/route";
import { autorizarPorAnuncio } from "../ads/enforcement";
import { resolverPromocaoTv } from "../ads/promocaoTv";
import { anuncioAndroidAtivo } from "../playbackAuthorization";
import { PLANO_GRATUITO, PLANO_PREMIUM } from "../planos";
import type { AlvoDeConcessao } from "../ads/concessoes";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * `ANUNCIO_ANDROID_ATIVO`: o interstitial do Unity volta a ser exigido no Android
 * móvel em Production com a global `MONETIZACAO_ATIVA=false`, **sem** ligar
 * enforcement para Web, Android TV ou Electron.
 *
 * A irmã de `promocaoTvFlag.test.ts`, para a outra plataforma que monetiza.
 * Prova, pelas rotas reais, o combinado: global desligada + Android ligado só
 * muda o Android; todo o resto segue idêntico a `MONETIZACAO_ATIVA=false`. Redis
 * é o MemoryStore real; sessão, entitlements e relógio entram por injeção.
 */

function direitosDe(plano: PlanoSemeado, ajuste: Partial<DireitosDoPlano> = {}): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return { ...(direitos as DireitosDoPlano), ...ajuste };
}
const entitlementsDe = (plano: PlanoSemeado, ajuste: Partial<DireitosDoPlano> = {}): Entitlements => ({
  assinatura: { ativa: plano.id !== "gratuito", planoId: plano.id, expiraEm: null },
  direitos: direitosDe(plano, ajuste),
});

let sequencia = 0;
const novoUsuario = () => `u_androidflag_${Date.now()}_${++sequencia}`;

// Config válida de promoção da TV, só para os cenários que provam que a TV NÃO
// reage à flag do Android.
const ENV_TV_OK = {
  PROMOCAO_TV_VIDEO_URL: "https://midia.invalido/promo/tv-planos.mp4",
  PROMOCAO_TV_DURACAO_SEG: "30",
  PROMOCAO_TV_VERSAO: "planos-v1",
};

type Credencial = { origem: "cookie" | "bearer"; deviceId: string | null };
const TV: Credencial = { origem: "bearer", deviceId: "androidflag_tv_1" };
const CELULAR: Credencial = { origem: "cookie", deviceId: null };

type Req = Parameters<typeof authorizePost>[0];
const req = (corpo: unknown): Req =>
  new Request("https://obaflix.test/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  }) as unknown as Req;

interface Cenario {
  userId: string;
  plano?: PlanoSemeado;
  ajuste?: Partial<DireitosDoPlano>;
  credencial?: Credencial;
  /** MONETIZACAO_ATIVA. Default: desligada — é o cenário de Production. */
  global?: boolean;
  /** ANUNCIO_ANDROID_ATIVO. Default: desligada. */
  android?: boolean;
  /** PROMOCAO_TV_ATIVA. Default: desligada. */
  tv?: boolean;
  env?: Record<string, string | undefined>;
  entitlementsDoUsuario?: () => Promise<Entitlements>;
}

function portas(c: Cenario) {
  const credencial = c.credencial ?? CELULAR;
  return {
    getUserFromRequest: async () => ({ userId: c.userId, role: "user", ...credencial }),
    monetizacaoAtiva: () => c.global ?? false,
    promocaoTvAtiva: () => c.tv ?? false,
    anuncioAndroidAtivo: () => c.android ?? false,
    entitlementsDoUsuario:
      c.entitlementsDoUsuario ?? (async () => entitlementsDe(c.plano ?? PLANO_GRATUITO, c.ajuste)),
    isIpBlocked: async () => false,
    recordAbuseAttempt: async () => {},
  };
}

const autorizar = (c: Cenario, corpo: Record<string, unknown>) =>
  authorizePost.createForTest({
    ...portas(c),
    resolverDirectLink: () => ({ situacao: "indisponivel" }),
    resolverPromocaoTv: () => resolverPromocaoTv(c.env ?? ENV_TV_OK),
    conteudoExiste: async () => true,
  })(req(corpo));

const iniciar = (c: Cenario, desafioId: unknown, agora: number) =>
  iniciarPost.createForTest({
    ...portas(c),
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    agora: () => agora,
  })(req({ desafioId }));

const concluir = (c: Cenario, corpo: Record<string, unknown>, agora: number) =>
  completePost.createForTest({
    ...portas(c),
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    agora: () => agora,
  })(req(corpo));

const FILME = { conteudoId: "filme_androidflag_1", conteudoTipo: "filme" };
const ALVO_FILME: AlvoDeConcessao = { tipo: "filme", conteudoId: "filme_androidflag_1", temporada: null, episodio: null };

/** Longe o bastante para satisfazer qualquer tempo mínimo de anúncio. */
const DEPOIS = () => Date.now() + 10 * 60_000;

/** O portão de `/fontes`, com a plataforma e as flags que se quer provar. */
const portaDeFontes = (
  userId: string,
  plataforma: "android_tv" | "android" | "electron" | "web",
  flags: { global: boolean; tv: boolean; android: boolean },
  concessao: string | null,
  alvo: AlvoDeConcessao = ALVO_FILME,
) =>
  autorizarPorAnuncio(
    { userId, tipo: alvo.tipo, concessao, finalidade: "reproducao", alvo, plataforma },
    {
      ativa: flags.global,
      promocaoTvAtiva: flags.tv,
      anuncioAndroidAtivo: flags.android,
      resolver: async () => entitlementsDe(PLANO_GRATUITO),
    },
  );

describe("ANUNCIO_ANDROID_ATIVO — interpretação estrita", () => {
  test('somente a string exata "true" liga', () => {
    assert.equal(anuncioAndroidAtivo({ ANUNCIO_ANDROID_ATIVO: "true" }), true);
    for (const valor of [undefined, "", "false", "1", "TRUE", "True", " true", "true "]) {
      assert.equal(anuncioAndroidAtivo({ ANUNCIO_ANDROID_ATIVO: valor }), false, String(valor));
    }
  });
});

// ── authorize por plataforma (global desligada) ──────────────────────────────

describe("ANUNCIO_ANDROID_ATIVO — authorize por plataforma (global desligada)", () => {
  test("1. global=false, android=false, Android → PERMITIDO sem consultar entitlements", async () => {
    let consultou = false;
    const r = await authorizePost.createForTest({
      ...portas({ userId: novoUsuario(), global: false, android: false, credencial: CELULAR }),
      entitlementsDoUsuario: async () => { consultou = true; throw new Error("não devia consultar"); },
      resolverDirectLink: () => ({ situacao: "indisponivel" }),
      resolverPromocaoTv: () => resolverPromocaoTv(ENV_TV_OK),
      conteudoExiste: async () => true,
    })(req({ ...FILME, plataforma: "android" }));
    assert.deepEqual(await r.json(), { decisao: "PERMITIDO" });
    assert.equal(consultou, false);
  });

  test("2. global=false, android=true, Android gratuito → ANUNCIO_NECESSARIO", async () => {
    const r = await autorizar(
      { userId: novoUsuario(), global: false, android: true, plano: PLANO_GRATUITO, credencial: CELULAR },
      { ...FILME, plataforma: "android" },
    );
    const auth = await r.json();
    assert.equal(r.status, 200);
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    assert.match(auth.desafioId, /^[A-Za-z0-9_-]{16,64}$/);
  });

  test("3. global=false, android=true, Android pago (sem anunciosObrigatorios) → PERMITIDO", async () => {
    const auth = await (await autorizar(
      { userId: novoUsuario(), global: false, android: true, plano: PLANO_PREMIUM, credencial: CELULAR },
      { ...FILME, plataforma: "android" },
    )).json();
    assert.equal(auth.decisao, "PERMITIDO");
  });

  test("4. TV NÃO reage à flag Android: global=false, android=true, tv=false → PERMITIDO, sem entitlements", async () => {
    let consultou = false;
    const r = await authorizePost.createForTest({
      ...portas({ userId: novoUsuario(), global: false, android: true, tv: false, credencial: TV }),
      entitlementsDoUsuario: async () => { consultou = true; throw new Error("não devia consultar"); },
      resolverDirectLink: () => ({ situacao: "indisponivel" }),
      resolverPromocaoTv: () => resolverPromocaoTv(ENV_TV_OK),
      conteudoExiste: async () => true,
    })(req({ ...FILME, plataforma: "android" })); // corpo declara android, mas credencial de TV vence → android_tv
    assert.deepEqual(await r.json(), { decisao: "PERMITIDO" });
    assert.equal(consultou, false, "a flag do Android não pode ligar enforcement para a TV");
  });

  for (const [nome, plataforma] of [
    ["5. Electron", "electron"],
    ["6. Web", undefined],
  ] as const) {
    test(`${nome} NÃO reage à flag Android: global=false, android=true → PERMITIDO, sem entitlements`, async () => {
      let consultou = false;
      const r = await authorizePost.createForTest({
        ...portas({ userId: novoUsuario(), global: false, android: true, credencial: CELULAR }),
        entitlementsDoUsuario: async () => { consultou = true; throw new Error("não devia consultar"); },
        resolverDirectLink: () => ({ situacao: "indisponivel" }),
        resolverPromocaoTv: () => resolverPromocaoTv(ENV_TV_OK),
        conteudoExiste: async () => true,
      })(req({ ...FILME, plataforma }));
      assert.deepEqual(await r.json(), { decisao: "PERMITIDO" });
      assert.equal(consultou, false, "o enforcement do Android não pode entrar no caminho de outros clientes");
    });
  }
});

// ── complete: concessão só para a plataforma da flag ─────────────────────────

describe("ANUNCIO_ANDROID_ATIVO — concluir o anúncio (só Android flag)", () => {
  test("7. Android conclui o anúncio e recebe concessão válida com só a flag do Android", async () => {
    const c: Cenario = { userId: novoUsuario(), global: false, android: true, credencial: CELULAR };
    const auth = await (await autorizar(c, { ...FILME, plataforma: "android" })).json();
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");

    const rFim = await concluir(c, { desafioId: auth.desafioId, concluido: true }, DEPOIS());
    assert.equal(rFim.status, 200, "concluir funciona só com ANUNCIO_ANDROID_ATIVO");
    assert.equal(typeof (await rFim.json()).concessao, "string");
  });

  test("8. /fontes do Android exige e consome a concessão emitida", async () => {
    const c: Cenario = { userId: novoUsuario(), global: false, android: true, credencial: CELULAR };
    const auth = await (await autorizar(c, { ...FILME, plataforma: "android" })).json();
    const { concessao } = await (await concluir(c, { desafioId: auth.desafioId }, DEPOIS())).json();
    assert.equal(typeof concessao, "string");

    // Sem concessão: recusa.
    const semConcessao = await portaDeFontes(c.userId, "android", { global: false, tv: false, android: true }, null);
    assert.deepEqual(semConcessao, { liberado: false, motivo: "sem_concessao" });

    // Com a concessão válida: libera e consome.
    const comConcessao = await portaDeFontes(c.userId, "android", { global: false, tv: false, android: true }, concessao);
    assert.deepEqual(comConcessao, { liberado: true, via: "concessao" });

    // Reenviar a mesma concessão não repete: já foi consumida.
    const reuso = await portaDeFontes(c.userId, "android", { global: false, tv: false, android: true }, concessao);
    assert.deepEqual(reuso, { liberado: false, motivo: "concessao_invalida" });
  });

  test("9. desafio de Android NÃO conclui com só a flag da TV ligada", async () => {
    const c: Cenario = { userId: novoUsuario(), global: false, android: true, credencial: CELULAR };
    const auth = await (await autorizar(c, { ...FILME, plataforma: "android" })).json();
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");

    // Global desligada e só a flag da TV: o desafio de Android não vira concessão.
    const r = await concluir(
      { userId: c.userId, global: false, android: false, tv: true, credencial: CELULAR },
      { desafioId: auth.desafioId, concluido: true },
      DEPOIS(),
    );
    assert.equal(r.status, 403);
    assert.equal((await r.json()).concessao, undefined);
  });

  test("10. desafio de TV NÃO conclui com só a flag do Android ligada", async () => {
    const tvCen: Cenario = { userId: novoUsuario(), global: false, tv: true, credencial: TV };
    const auth = await (await autorizar(tvCen, FILME)).json();
    assert.equal(auth.decisao, "PROMOCAO_TV_NECESSARIA");
    const inicio = Date.now() + 1_000;
    await iniciar(tvCen, auth.desafioId, inicio);

    // Global desligada e só a flag do Android: o desafio de TV não vira concessão.
    const r = await concluir(
      { userId: tvCen.userId, global: false, android: true, tv: false, credencial: TV },
      { desafioId: auth.desafioId, concluido: true },
      inicio + 40_000,
    );
    assert.equal(r.status, 403);
    assert.equal((await r.json()).concessao, undefined);
  });

  test("11. global=false e nenhuma flag: /ads/complete responde 404 (porta fechada)", async () => {
    const r = await concluir(
      { userId: novoUsuario(), global: false, android: false, tv: false, credencial: CELULAR },
      { desafioId: "x".repeat(22), concluido: true },
      DEPOIS(),
    );
    assert.equal(r.status, 404);
  });
});

// ── /fontes por plataforma ───────────────────────────────────────────────────

describe("ANUNCIO_ANDROID_ATIVO — /fontes cobra só o Android", () => {
  test("12. /fontes do Android exige concessão quando a flag do Android está ligada", async () => {
    const r = await portaDeFontes(novoUsuario(), "android", { global: false, tv: false, android: true }, null);
    assert.deepEqual(r, { liberado: false, motivo: "sem_concessao" });
  });

  for (const plataforma of ["android_tv", "electron", "web"] as const) {
    test(`13. ${plataforma}: /fontes segue no bypass com global=false, mesmo com a flag do Android ligada`, async () => {
      const r = await portaDeFontes(novoUsuario(), plataforma, { global: false, tv: false, android: true }, null);
      assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
    });
  }

  test("14. Android + flag Android=false + global=false → bypass atual (flag_desligada)", async () => {
    const r = await portaDeFontes(novoUsuario(), "android", { global: false, tv: false, android: false }, null);
    assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
  });
});
