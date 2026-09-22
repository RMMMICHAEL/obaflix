import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { POST as authorizePost } from "@/app/api/playback/authorize/route";
import { POST as completePost } from "@/app/api/ads/complete/route";
import { POST as iniciarPost } from "@/app/api/ads/promocao/iniciar/route";
import { autorizarPorAnuncio } from "../ads/enforcement";
import { resolverPromocaoTv } from "../ads/promocaoTv";
import { promocaoTvAtiva } from "../playbackAuthorization";
import { PLANO_GRATUITO, PLANO_PREMIUM } from "../planos";
import type { AlvoDeConcessao } from "../ads/concessoes";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * `PROMOCAO_TV_ATIVA`: a promoção da Android TV funciona em Production com a
 * global `MONETIZACAO_ATIVA=false`, **sem** ligar enforcement para Web, Android
 * móvel ou Electron.
 *
 * Prova, pelas rotas reais, o combinado: global desligada + TV ligada só muda a
 * TV; todo o resto segue idêntico a `MONETIZACAO_ATIVA=false`. Redis é o
 * MemoryStore real; sessão, entitlements e relógio entram por injeção.
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
const novoUsuario = () => `u_tvflag_${Date.now()}_${++sequencia}`;

const DURACAO_S = 30;
const ENV_OK = {
  PROMOCAO_TV_VIDEO_URL: "https://midia.invalido/promo/tv-planos.mp4",
  PROMOCAO_TV_DURACAO_SEG: String(DURACAO_S),
  PROMOCAO_TV_VERSAO: "planos-v1",
};

type Credencial = { origem: "cookie" | "bearer"; deviceId: string | null };
const TV: Credencial = { origem: "bearer", deviceId: "tvflag_aparelho_1" };
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
  /** PROMOCAO_TV_ATIVA. Default: desligada. */
  tv?: boolean;
  env?: Record<string, string | undefined>;
  entitlementsDoUsuario?: () => Promise<Entitlements>;
}

function portas(c: Cenario) {
  const credencial = c.credencial ?? TV;
  return {
    getUserFromRequest: async () => ({ userId: c.userId, role: "user", ...credencial }),
    monetizacaoAtiva: () => c.global ?? false,
    promocaoTvAtiva: () => c.tv ?? false,
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
    resolverPromocaoTv: () => resolverPromocaoTv(c.env ?? ENV_OK),
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

const FILME = { conteudoId: "filme_tvflag_1", conteudoTipo: "filme" };
const ALVO_FILME: AlvoDeConcessao = { tipo: "filme", conteudoId: "filme_tvflag_1", temporada: null, episodio: null };

/** O portão de `/fontes`, com a plataforma e as flags que se quer provar. */
const portaDeFontes = (
  userId: string,
  plataforma: "android_tv" | "android" | "electron" | "web",
  flags: { global: boolean; tv: boolean },
  concessao: string | null,
  alvo: AlvoDeConcessao = ALVO_FILME,
) =>
  autorizarPorAnuncio(
    { userId, tipo: alvo.tipo, concessao, finalidade: "reproducao", alvo, plataforma },
    { ativa: flags.global, promocaoTvAtiva: flags.tv, resolver: async () => entitlementsDe(PLANO_GRATUITO) },
  );

describe("PROMOCAO_TV_ATIVA — interpretação estrita", () => {
  test('somente a string exata "true" liga', () => {
    assert.equal(promocaoTvAtiva({ PROMOCAO_TV_ATIVA: "true" }), true);
    for (const valor of [undefined, "", "false", "1", "TRUE", "True", " true", "true "]) {
      assert.equal(promocaoTvAtiva({ PROMOCAO_TV_ATIVA: valor }), false, String(valor));
    }
  });
});

// ── 1–6: /playback/authorize por plataforma ──────────────────────────────────

describe("PROMOCAO_TV_ATIVA — authorize por plataforma (global desligada)", () => {
  test("1. global=false, tv=false, TV → PERMITIDO sem consultar entitlements", async () => {
    let consultou = false;
    const r = await authorizePost.createForTest({
      ...portas({ userId: novoUsuario(), global: false, tv: false }),
      entitlementsDoUsuario: async () => { consultou = true; throw new Error("não devia consultar"); },
      resolverPromocaoTv: () => resolverPromocaoTv(ENV_OK),
      conteudoExiste: async () => true,
    })(req(FILME));
    assert.deepEqual(await r.json(), { decisao: "PERMITIDO" });
    assert.equal(consultou, false);
  });

  test("2. global=false, tv=true, TV gratuita → PROMOCAO_TV_NECESSARIA", async () => {
    const r = await autorizar({ userId: novoUsuario(), global: false, tv: true, plano: PLANO_GRATUITO }, FILME);
    const auth = await r.json();
    assert.equal(r.status, 200);
    assert.equal(auth.decisao, "PROMOCAO_TV_NECESSARIA");
    assert.match(auth.desafioId, /^[A-Za-z0-9_-]{16,64}$/);
  });

  test("3. global=false, tv=true, TV sem anunciosObrigatorios → PERMITIDO", async () => {
    const auth = await (await autorizar(
      { userId: novoUsuario(), global: false, tv: true, plano: PLANO_GRATUITO, ajuste: { anunciosObrigatorios: false } },
      FILME,
    )).json();
    assert.deepEqual(auth, { decisao: "PERMITIDO" });
  });

  for (const [nome, credencial, plataforma] of [
    ["4. Android móvel", CELULAR, "android"],
    ["5. Electron", CELULAR, "electron"],
    ["6. Web", CELULAR, undefined],
  ] as const) {
    test(`${nome}: global=false, tv=true → PERMITIDO (inalterado), sem consultar entitlements`, async () => {
      let consultou = false;
      const r = await authorizePost.createForTest({
        ...portas({ userId: novoUsuario(), global: false, tv: true, credencial }),
        entitlementsDoUsuario: async () => { consultou = true; throw new Error("não devia consultar"); },
        resolverPromocaoTv: () => resolverPromocaoTv(ENV_OK),
        conteudoExiste: async () => true,
      })(req({ ...FILME, plataforma }));
      assert.deepEqual(await r.json(), { decisao: "PERMITIDO" });
      assert.equal(consultou, false, "o enforcement não pode entrar no caminho de outros clientes");
    });
  }
});

// ── 7–9: iniciar e complete só para a TV ──────────────────────────────────────

describe("PROMOCAO_TV_ATIVA — iniciar e concluir (só TV flag)", () => {
  test("7 e 8. iniciar e concluir a promoção da TV funcionam com só a TV flag", async () => {
    const c: Cenario = { userId: novoUsuario(), global: false, tv: true };
    const auth = await (await autorizar(c, FILME)).json();
    assert.equal(auth.decisao, "PROMOCAO_TV_NECESSARIA");

    const inicio = Date.now() + 1_000;
    const rIni = await iniciar(c, auth.desafioId, inicio);
    assert.equal(rIni.status, 200, "iniciar funciona só com PROMOCAO_TV_ATIVA");

    const rFim = await concluir(c, { desafioId: auth.desafioId, concluido: true }, inicio + DURACAO_S * 1000 + 800);
    assert.equal(rFim.status, 200, "concluir funciona só com PROMOCAO_TV_ATIVA");
    assert.equal(typeof (await rFim.json()).concessao, "string");
  });

  test("9. desafio de Android/Electron NÃO conclui só porque a TV flag está ligada", async () => {
    // Cria um desafio de celular com a GLOBAL ligada (é o único jeito de existir).
    const userId = novoUsuario();
    const mobile: Cenario = { userId, global: true, tv: false, credencial: CELULAR };
    const auth = await (await autorizar(mobile, { ...FILME, plataforma: "android" })).json();
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    assert.equal(typeof auth.desafioId, "string");

    // Agora, com a GLOBAL desligada e só a TV flag, esse desafio não vira concessão.
    const r = await concluir(
      { userId, global: false, tv: true, credencial: CELULAR },
      { desafioId: auth.desafioId, concluido: true },
      Date.now() + 10 * 60_000,
    );
    assert.equal(r.status, 403);
    assert.equal((await r.json()).concessao, undefined);
  });
});

// ── 10–12: enforcement em /fontes, por plataforma ─────────────────────────────

describe("PROMOCAO_TV_ATIVA — /fontes cobra só a TV", () => {
  test("10. /fontes da TV exige concessão quando a TV flag está ligada", async () => {
    const r = await portaDeFontes(novoUsuario(), "android_tv", { global: false, tv: true }, null);
    assert.deepEqual(r, { liberado: false, motivo: "sem_concessao" });
  });

  test("11. /fontes da TV aceita a concessão válida emitida após a promoção", async () => {
    const c: Cenario = { userId: novoUsuario(), global: false, tv: true };
    const auth = await (await autorizar(c, FILME)).json();
    const inicio = Date.now() + 1_000;
    await iniciar(c, auth.desafioId, inicio);
    const { concessao } = await (await concluir(c, { desafioId: auth.desafioId }, inicio + DURACAO_S * 1000 + 800)).json();
    assert.equal(typeof concessao, "string");

    const r = await portaDeFontes(c.userId, "android_tv", { global: false, tv: true }, concessao);
    assert.deepEqual(r, { liberado: true, via: "concessao" });
  });

  for (const plataforma of ["android", "electron", "web"] as const) {
    test(`12. ${plataforma}: /fontes segue no bypass com global=false, mesmo com a TV flag ligada`, async () => {
      const r = await portaDeFontes(novoUsuario(), plataforma, { global: false, tv: true }, null);
      assert.deepEqual(r, { liberado: true, via: "flag_desligada" });
    });
  }
});

// ── 13–14: fail-closed da configuração continua valendo sob a TV flag ──────────

describe("PROMOCAO_TV_ATIVA — configuração da promoção continua fail-closed", () => {
  test("13. PROMOCAO_TV_VIDEO_URL ausente/inválida → ANUNCIO_INDISPONIVEL na TV", async () => {
    for (const env of [{}, { ...ENV_OK, PROMOCAO_TV_VIDEO_URL: "http://x.invalido/v.mp4" }]) {
      const auth = await (await autorizar({ userId: novoUsuario(), global: false, tv: true, env }, FILME)).json();
      assert.deepEqual(auth, { decisao: "ANUNCIO_INDISPONIVEL", codigo: "anuncio_indisponivel" });
    }
  });

  test("14. duração inválida → ANUNCIO_INDISPONIVEL na TV", async () => {
    for (const dur of ["0", "9", "181", "30.5", "trinta"]) {
      const env = { ...ENV_OK, PROMOCAO_TV_DURACAO_SEG: dur };
      const auth = await (await autorizar({ userId: novoUsuario(), global: false, tv: true, env }, FILME)).json();
      assert.deepEqual(auth, { decisao: "ANUNCIO_INDISPONIVEL", codigo: "anuncio_indisponivel" }, dur);
    }
  });
});
