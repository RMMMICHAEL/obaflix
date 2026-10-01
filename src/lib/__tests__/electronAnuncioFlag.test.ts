import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { POST as authorizePost } from "@/app/api/playback/authorize/route";
import { POST as completePost } from "@/app/api/ads/complete/route";
import { GET as cliqueGet } from "@/app/api/ads/click-desktop/route";
import { autorizarPorAnuncio } from "../ads/enforcement";
import { DIRECT_LINK_ELECTRON, resolverDirectLink } from "../ads/directLink";
import { ehRequisicaoElectron } from "../ads/politica";
import { resolverPromocaoTv } from "../ads/promocaoTv";
import { anuncioElectronAtivo } from "../playbackAuthorization";
import { PLANO_GRATUITO, PLANO_PREMIUM } from "../planos";
import type { AlvoDeConcessao } from "../ads/concessoes";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * `ANUNCIO_ELECTRON_ATIVO`: o convite + Direct Link antes da reprodução volta a ser
 * exigido no Electron em Production com a global `MONETIZACAO_ATIVA=false`, **sem**
 * ligar enforcement para Web, Android ou Android TV, e sem tocar no anúncio por
 * clique.
 *
 * A terceira irmã de `promocaoTvFlag.test.ts` e `androidAnuncioFlag.test.ts`. Prova,
 * pelas rotas reais, que a flag cobra de verdade — inclusive em `/fontes`, onde o
 * player manda `ambiente: "electron"` e nenhuma `plataforma` —, e que rebaixar a
 * requisição para `web` de dentro do app não escapa. Redis é o MemoryStore real;
 * sessão, entitlements e relógio entram por injeção.
 */

function direitosDe(plano: PlanoSemeado, ajuste: Partial<DireitosDoPlano> = {}): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return { ...(direitos as DireitosDoPlano), ...ajuste };
}
const entitlementsDe = (plano: PlanoSemeado): Entitlements => ({
  assinatura: { ativa: plano.id !== "gratuito", planoId: plano.id, expiraEm: null },
  direitos: direitosDe(plano),
});

let sequencia = 0;
const novoUsuario = () => `u_electronflag_${Date.now()}_${++sequencia}`;

const ENV_TV_OK = {
  PROMOCAO_TV_VIDEO_URL: "https://midia.invalido/promo/tv-planos.mp4",
  PROMOCAO_TV_DURACAO_SEG: "30",
  PROMOCAO_TV_VERSAO: "planos-v1",
};

type Credencial = { origem: "cookie" | "bearer"; deviceId: string | null };
const TV: Credencial = { origem: "bearer", deviceId: "electronflag_tv_1" };
const COOKIE: Credencial = { origem: "cookie", deviceId: null };

const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36 ObaflixDesktop/1.0";
const UA_NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36";

type Req = Parameters<typeof authorizePost>[0];
const req = (corpo: unknown, headers: Record<string, string> = {}): Req =>
  new Request("https://obaflix.test/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": UA_NAVEGADOR, ...headers },
    body: JSON.stringify(corpo),
  }) as unknown as Req;

/** Os headers que o `main.js` do Electron injeta em toda requisição ao site. */
const DO_ELECTRON = { "user-agent": UA_DESKTOP, "x-obaflix-client": "desktop" };

interface Cenario {
  userId: string;
  plano?: PlanoSemeado;
  credencial?: Credencial;
  /** MONETIZACAO_ATIVA. Default: desligada — é o cenário de Production. */
  global?: boolean;
  /** ANUNCIO_ELECTRON_ATIVO. Default: desligada. */
  electron?: boolean;
  /** ANUNCIO_ANDROID_ATIVO. Default: desligada. */
  android?: boolean;
  /** PROMOCAO_TV_ATIVA. Default: desligada. */
  tv?: boolean;
}

function portas(c: Cenario) {
  const credencial = c.credencial ?? COOKIE;
  return {
    getUserFromRequest: async () => ({ userId: c.userId, role: "user", ...credencial }),
    monetizacaoAtiva: () => c.global ?? false,
    promocaoTvAtiva: () => c.tv ?? false,
    anuncioAndroidAtivo: () => c.android ?? false,
    anuncioElectronAtivo: () => c.electron ?? false,
    entitlementsDoUsuario: async () => entitlementsDe(c.plano ?? PLANO_GRATUITO),
    isIpBlocked: async () => false,
    recordAbuseAttempt: async () => {},
  };
}

/** `/authorize` com o Direct Link real (sem env → o homologado). */
const autorizar = (c: Cenario, corpo: Record<string, unknown>, headers: Record<string, string> = {}) =>
  authorizePost.createForTest({
    ...portas(c),
    resolverDirectLink: () => resolverDirectLink({}),
    resolverPromocaoTv: () => resolverPromocaoTv(ENV_TV_OK),
    conteudoExiste: async () => true,
  })(req(corpo, headers));

/** `/authorize` que falha se tocar em entitlements: prova o bypass sem custo. */
const autorizarSemConsulta = async (c: Cenario, corpo: Record<string, unknown>, headers: Record<string, string> = {}) => {
  let consultou = false;
  const r = await authorizePost.createForTest({
    ...portas(c),
    entitlementsDoUsuario: async () => { consultou = true; throw new Error("não devia consultar"); },
    resolverDirectLink: () => resolverDirectLink({}),
    resolverPromocaoTv: () => resolverPromocaoTv(ENV_TV_OK),
    conteudoExiste: async () => true,
  })(req(corpo, headers));
  return { corpo: await r.json(), consultou };
};

const concluir = (c: Cenario, corpo: Record<string, unknown>, agora: number) =>
  completePost.createForTest({
    ...portas(c),
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    agora: () => agora,
  })(req(corpo, DO_ELECTRON));

const FILME = { conteudoId: "filme_electronflag_1", conteudoTipo: "filme" };
const ALVO_FILME: AlvoDeConcessao = { tipo: "filme", conteudoId: "filme_electronflag_1", temporada: null, episodio: null };
const DEPOIS = () => Date.now() + 10 * 60_000;

type Flags = { global?: boolean; tv?: boolean; android?: boolean; electron?: boolean };

/**
 * O portão de `/fontes` exatamente como a rota chama: a plataforma do corpo (que o
 * player não manda → `web`) e o sinal de Electron calculado por `ehRequisicaoElectron`
 * a partir de `ambiente` e dos headers.
 */
const portaDeFontes = (
  userId: string,
  entrada: { plataforma: "android_tv" | "android" | "electron" | "web"; electron: boolean },
  flags: Flags,
  concessao: string | null,
  plano: PlanoSemeado = PLANO_GRATUITO,
) =>
  autorizarPorAnuncio(
    { userId, tipo: "filme", concessao, finalidade: "reproducao", alvo: ALVO_FILME, ...entrada },
    {
      ativa: flags.global ?? false,
      promocaoTvAtiva: flags.tv ?? false,
      anuncioAndroidAtivo: flags.android ?? false,
      anuncioElectronAtivo: flags.electron ?? false,
      resolver: async () => entitlementsDe(plano),
    },
  );

/** O que o player do Electron manda para `/fontes`: `ambiente`, sem `plataforma`. */
const FONTES_DO_ELECTRON = {
  plataforma: "web" as const,
  electron: ehRequisicaoElectron({
    plataforma: "web",
    ambienteDeclarado: "electron",
    userAgent: UA_DESKTOP,
    headerCliente: "desktop",
  }),
};

// ── Flag e reconhecimento do Electron ────────────────────────────────────────

describe("ANUNCIO_ELECTRON_ATIVO — interpretação estrita", () => {
  test('somente a string exata "true" liga', () => {
    assert.equal(anuncioElectronAtivo({ ANUNCIO_ELECTRON_ATIVO: "true" }), true);
    for (const valor of [undefined, "", "false", "1", "TRUE", "True", " true", "true "]) {
      assert.equal(anuncioElectronAtivo({ ANUNCIO_ELECTRON_ATIVO: valor }), false, String(valor));
    }
  });

  test("Direct Link efetivo sem ANUNCIO_DIRECT_LINK_URL é o homologado, e outro valor é recusado", () => {
    assert.deepEqual(resolverDirectLink({}), { situacao: "ok", url: "https://omg10.com/4/11767843" });
    assert.equal(DIRECT_LINK_ELECTRON, "https://omg10.com/4/11767843");
    assert.deepEqual(resolverDirectLink({ ANUNCIO_DIRECT_LINK_URL: "https://outro.invalido/x" }), { situacao: "indisponivel" });
  });
});

describe("ehRequisicaoElectron — qualquer sinal basta, TV nunca", () => {
  test("plataforma, ambiente, header ou User-Agent do Electron", () => {
    assert.equal(ehRequisicaoElectron({ plataforma: "electron" }), true);
    assert.equal(ehRequisicaoElectron({ plataforma: "web", ambienteDeclarado: "electron" }), true);
    assert.equal(ehRequisicaoElectron({ plataforma: "web", headerCliente: "desktop" }), true);
    assert.equal(ehRequisicaoElectron({ plataforma: "web", userAgent: UA_DESKTOP }), true);
  });

  test("navegador, Android e TV não são Electron", () => {
    assert.equal(ehRequisicaoElectron({ plataforma: "web", userAgent: UA_NAVEGADOR }), false);
    assert.equal(ehRequisicaoElectron({ plataforma: "android", headerCliente: "android" }), false);
    assert.equal(ehRequisicaoElectron({ plataforma: "android_tv", ambienteDeclarado: "electron", headerCliente: "desktop" }), false);
  });
});

// ── /playback/authorize ──────────────────────────────────────────────────────

describe("ANUNCIO_ELECTRON_ATIVO — /playback/authorize (global desligada)", () => {
  test("1. Electron + flag off + global off → PERMITIDO sem consultar entitlements (comportamento atual)", async () => {
    const r = await autorizarSemConsulta(
      { userId: novoUsuario(), electron: false },
      { ...FILME, plataforma: "electron" },
      DO_ELECTRON,
    );
    assert.deepEqual(r.corpo, { decisao: "PERMITIDO" });
    assert.equal(r.consultou, false);
  });

  test("2. Electron + flag on + gratuito → ANUNCIO_NECESSARIO com o Direct Link homologado", async () => {
    const r = await autorizar(
      { userId: novoUsuario(), electron: true, plano: PLANO_GRATUITO },
      { ...FILME, plataforma: "electron" },
      DO_ELECTRON,
    );
    const auth = await r.json();
    assert.equal(r.status, 200);
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    assert.match(auth.desafioId, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(auth.directLink, "https://omg10.com/4/11767843");
  });

  test("3. Electron + flag on + pago → PERMITIDO, sem desafio e sem Direct Link (não vê modal)", async () => {
    const auth = await (await autorizar(
      { userId: novoUsuario(), electron: true, plano: PLANO_PREMIUM },
      { ...FILME, plataforma: "electron" },
      DO_ELECTRON,
    )).json();
    assert.equal(auth.directLink, undefined);
    assert.equal(auth.desafioId, undefined);
    assert.deepEqual(auth, { decisao: "PERMITIDO" });
  });

  test("4. Web NÃO é afetado: flag Electron on → PERMITIDO sem entitlements", async () => {
    const r = await autorizarSemConsulta({ userId: novoUsuario(), electron: true }, { ...FILME });
    assert.deepEqual(r.corpo, { decisao: "PERMITIDO" });
    assert.equal(r.consultou, false);
  });

  test("5. Android NÃO reage à flag Electron: android off + electron on → PERMITIDO sem entitlements", async () => {
    const r = await autorizarSemConsulta(
      { userId: novoUsuario(), electron: true, android: false },
      { ...FILME, plataforma: "android" },
      { "x-obaflix-client": "android" },
    );
    assert.deepEqual(r.corpo, { decisao: "PERMITIDO" });
    assert.equal(r.consultou, false);
  });

  test("6. TV NÃO reage à flag Electron, nem com header de desktop: tv off + electron on → PERMITIDO", async () => {
    const r = await autorizarSemConsulta(
      { userId: novoUsuario(), electron: true, tv: false, credencial: TV },
      { ...FILME, plataforma: "electron" },
      DO_ELECTRON,
    );
    assert.deepEqual(r.corpo, { decisao: "PERMITIDO" });
    assert.equal(r.consultou, false);
  });

  test("7. Rebaixar para web de dentro do app não escapa: recusa (ANUNCIO_INDISPONIVEL), nunca PERMITIDO", async () => {
    const auth = await (await autorizar(
      { userId: novoUsuario(), electron: true, plano: PLANO_GRATUITO },
      { ...FILME }, // sem plataforma no corpo
      DO_ELECTRON,
    )).json();
    assert.equal(auth.decisao, "ANUNCIO_INDISPONIVEL");
  });
});

// ── /ads/complete ────────────────────────────────────────────────────────────

describe("ANUNCIO_ELECTRON_ATIVO — /ads/complete só para desafio do Electron", () => {
  test("8. Electron conclui o anúncio e recebe concessão com só a flag do Electron", async () => {
    const c: Cenario = { userId: novoUsuario(), electron: true };
    const auth = await (await autorizar(c, { ...FILME, plataforma: "electron" }, DO_ELECTRON)).json();
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    const rFim = await concluir(c, { desafioId: auth.desafioId, concluido: true }, DEPOIS());
    assert.equal(rFim.status, 200);
    assert.equal(typeof (await rFim.json()).concessao, "string");
  });

  test("9. desafio do Electron NÃO conclui com só a flag do Android", async () => {
    const c: Cenario = { userId: novoUsuario(), electron: true };
    const auth = await (await autorizar(c, { ...FILME, plataforma: "electron" }, DO_ELECTRON)).json();
    const r = await concluir({ userId: c.userId, electron: false, android: true }, { desafioId: auth.desafioId }, DEPOIS());
    assert.equal(r.status, 403);
    assert.equal((await r.json()).concessao, undefined);
  });

  test("10. desafio do Android NÃO conclui com só a flag do Electron", async () => {
    const c: Cenario = { userId: novoUsuario(), android: true };
    const auth = await (await autorizar(c, { ...FILME, plataforma: "android" })).json();
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    const r = await concluir({ userId: c.userId, android: false, electron: true }, { desafioId: auth.desafioId }, DEPOIS());
    assert.equal(r.status, 403);
  });

  test("11. nenhuma flag: /ads/complete continua 404", async () => {
    const r = await concluir({ userId: novoUsuario() }, { desafioId: "x".repeat(22) }, DEPOIS());
    assert.equal(r.status, 404);
  });
});

// ── /player/fontes ───────────────────────────────────────────────────────────

describe("ANUNCIO_ELECTRON_ATIVO — /player/fontes cobra de verdade", () => {
  test("12. o player do Electron (ambiente, sem plataforma) é reconhecido", () => {
    assert.equal(FONTES_DO_ELECTRON.electron, true);
  });

  test("13. Electron + flag on + gratuito SEM concessão → recusa (a rota responde 403 anuncio_necessario)", async () => {
    const r = await portaDeFontes(novoUsuario(), FONTES_DO_ELECTRON, { electron: true }, null);
    assert.deepEqual(r, { liberado: false, motivo: "sem_concessao" });
  });

  test("14. concessão válida libera a reprodução, e reusar não repete", async () => {
    const c: Cenario = { userId: novoUsuario(), electron: true };
    const auth = await (await autorizar(c, { ...FILME, plataforma: "electron" }, DO_ELECTRON)).json();
    const { concessao } = await (await concluir(c, { desafioId: auth.desafioId }, DEPOIS())).json();
    assert.equal(typeof concessao, "string");

    assert.deepEqual(
      await portaDeFontes(c.userId, FONTES_DO_ELECTRON, { electron: true }, concessao),
      { liberado: true, via: "concessao" },
    );
    assert.deepEqual(
      await portaDeFontes(c.userId, FONTES_DO_ELECTRON, { electron: true }, concessao),
      { liberado: false, motivo: "concessao_invalida" },
    );
  });

  test("15. pago → liberado sem anúncio, sem precisar de concessão", async () => {
    const r = await portaDeFontes(novoUsuario(), FONTES_DO_ELECTRON, { electron: true }, null, PLANO_PREMIUM);
    assert.deepEqual(r, { liberado: true, via: "sem_anuncios" });
  });

  test("16. Electron + flag off + global off → bypass atual (flag_desligada)", async () => {
    const r = await portaDeFontes(novoUsuario(), FONTES_DO_ELECTRON, { electron: false }, null);
    assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
  });

  for (const plataforma of ["web", "android", "android_tv"] as const) {
    test(`17. ${plataforma}: segue no bypass com a flag do Electron ligada`, async () => {
      const r = await portaDeFontes(novoUsuario(), { plataforma, electron: false }, { electron: true }, null);
      assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
    });
  }

  test("18. TV com sinal de Electron continua TV: bypass com só a flag do Electron", async () => {
    const r = await portaDeFontes(novoUsuario(), { plataforma: "android_tv", electron: true }, { electron: true }, null);
    assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
  });

  test("19. Android e TV continuam respondendo às próprias flags", async () => {
    assert.deepEqual(
      await portaDeFontes(novoUsuario(), { plataforma: "android", electron: false }, { android: true }, null),
      { liberado: false, motivo: "sem_concessao" },
    );
    assert.deepEqual(
      await portaDeFontes(novoUsuario(), { plataforma: "android_tv", electron: false }, { tv: true }, null),
      { liberado: false, motivo: "sem_concessao" },
    );
  });

  test("20. a rota /fontes passa o sinal do Electron nas duas cobranças e recusa com 403", () => {
    const rota = readFileSync(join(process.cwd(), "src/app/api/player/fontes/route.ts"), "utf8");
    assert.match(rota, /ehRequisicaoElectron\(\{\s*plataforma: plataformaDoAnuncio,\s*ambienteDeclarado: corpo\.ambiente,/);
    assert.equal((rota.match(/electron: requisicaoElectron,/g) ?? []).length, 2);
    assert.equal((rota.match(/codigo: "anuncio_necessario" \},\s*\{ status: 403/g) ?? []).length, 2);
  });
});

// ── Anúncio por clique intacto ───────────────────────────────────────────────

describe("ANUNCIO_ELECTRON_ATIVO — não toca no anúncio por clique", () => {
  const pedidoDesktop = () =>
    new Request("https://obaflix.test/api/ads/click-desktop", { headers: { "user-agent": UA_DESKTOP } }) as never;

  test("21. clique ligado responde igual com ou sem a flag do Electron", async () => {
    for (const env of [
      { ANUNCIO_CLICK_DESKTOP_ATIVO: "true" },
      { ANUNCIO_CLICK_DESKTOP_ATIVO: "true", ANUNCIO_ELECTRON_ATIVO: "true" },
    ]) {
      const h = cliqueGet.createForTest({ env, getUserFromRequest: async () => null });
      assert.deepEqual(await (await h(pedidoDesktop())).json(), { exibir: true, intervaloCliques: 3, cooldownSeg: 120 });
    }
  });

  test("22. a flag do Electron sozinha não liga o anúncio por clique", async () => {
    const h = cliqueGet.createForTest({ env: { ANUNCIO_ELECTRON_ATIVO: "true" }, getUserFromRequest: async () => null });
    assert.deepEqual(await (await h(pedidoDesktop())).json(), { exibir: false });
  });
});
