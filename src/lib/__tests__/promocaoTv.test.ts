import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { POST as authorizePost } from "@/app/api/playback/authorize/route";
import { POST as completePost } from "@/app/api/ads/complete/route";
import { POST as iniciarPost } from "@/app/api/ads/promocao/iniciar/route";
import { GET as canaisGet } from "@/app/api/canais/route";
import { autorizarPorAnuncio } from "../ads/enforcement";
import {
  TOLERANCIA_RELOGIO_PROMOCAO_MS,
  TTL_CONCESSAO_PROMOCAO_TV_S,
  abrirDesafio,
  normalizarPlataforma,
  promocaoCumprida,
  type AlvoDeConcessao,
  type FinalidadeDeConcessao,
} from "../ads/concessoes";
import { meioDeExibicao, plataformaDaRequisicao } from "../ads/politica";
import { DURACAO_MAXIMA_S, DURACAO_MINIMA_S, resolverPromocaoTv } from "../ads/promocaoTv";
import { PLANO_BASIC, PLANO_GRATUITO, PLANO_PLUS, PLANO_PREMIUM } from "../planos";
import { getRedis } from "../redis";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * Promoção interna da Android TV, ponta a ponta, pelas **rotas reais**.
 *
 * `/playback/authorize` → `/ads/promocao/iniciar` → `/ads/complete` → o portão
 * de `/fontes`. Redis é o `MemoryStore` de verdade; sessão, entitlements,
 * catálogo e relógio entram por injeção — são o que não dá para ter aqui, não o
 * que está sendo testado.
 *
 * O relógio injetado é o que permite provar "concluiu antes do fim do vídeo"
 * sem esperar o vídeo.
 */

// ── Montagem ─────────────────────────────────────────────────────────────────

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
const novoUsuario = () => `u_tv_${Date.now()}_${++sequencia}`;

const DURACAO_S = 30;
const ENV_OK = {
  PROMOCAO_TV_VIDEO_URL: "https://midia.invalido/promo/tv-planos.mp4",
  PROMOCAO_TV_DURACAO_SEG: String(DURACAO_S),
  PROMOCAO_TV_VERSAO: "planos-v1",
};

type Credencial = { origem: "cookie" | "bearer"; deviceId: string | null };
const TV: Credencial = { origem: "bearer", deviceId: "tv_aparelho_1" };
const OUTRA_TV: Credencial = { origem: "bearer", deviceId: "tv_aparelho_2" };
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
  flag?: boolean;
  env?: Record<string, string | undefined>;
  conteudoExiste?: (alvo: AlvoDeConcessao) => Promise<boolean>;
}

function portas(c: Cenario) {
  const credencial = c.credencial ?? TV;
  return {
    getUserFromRequest: async () => ({ userId: c.userId, role: "user", ...credencial }),
    monetizacaoAtiva: () => c.flag ?? true,
    entitlementsDoUsuario: async () => entitlementsDe(c.plano ?? PLANO_GRATUITO, c.ajuste),
    isIpBlocked: async () => false,
    recordAbuseAttempt: async () => {},
  };
}

const autorizar = (c: Cenario, corpo: Record<string, unknown>) =>
  authorizePost.createForTest({
    ...portas(c),
    resolverDirectLink: () => ({ situacao: "indisponivel" }),
    resolverPromocaoTv: () => resolverPromocaoTv(c.env ?? ENV_OK),
    conteudoExiste: c.conteudoExiste ?? (async () => true),
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

const FILME = { conteudoId: "filme_tv_1", conteudoTipo: "filme" };
const ALVO_FILME: AlvoDeConcessao = { tipo: "filme", conteudoId: "filme_tv_1", temporada: null, episodio: null };

/** O portão de `/fontes`, com Redis real e entitlements injetados. */
const portaDeFontes = (
  userId: string,
  plano: PlanoSemeado,
  concessao: string | null,
  alvo: AlvoDeConcessao = ALVO_FILME,
  finalidade: FinalidadeDeConcessao = "reproducao",
) =>
  autorizarPorAnuncio(
    { userId, tipo: alvo.tipo, concessao, finalidade, alvo },
    { ativa: true, resolver: async () => entitlementsDe(plano) },
  );

/** Autoriza, inicia e conclui no tempo certo. Devolve os ids do caminho. */
async function assistirPromocao(c: Cenario, corpo: Record<string, unknown> = FILME) {
  const auth = await (await autorizar(c, corpo)).json();
  assert.equal(auth.decisao, "PROMOCAO_TV_NECESSARIA");
  const inicio = Date.now() + 1_000;
  const rIni = await iniciar(c, auth.desafioId, inicio);
  assert.equal(rIni.status, 200);
  const rFim = await concluir(c, { desafioId: auth.desafioId, concluido: true }, inicio + DURACAO_S * 1000 + 800);
  assert.equal(rFim.status, 200);
  const { concessao } = await rFim.json();
  assert.equal(typeof concessao, "string");
  return { desafioId: auth.desafioId as string, concessao: concessao as string, inicio };
}

// ── Configuração e regras puras ──────────────────────────────────────────────

describe("configuração da promoção", () => {
  test("válida: URL https, duração em ms e versão", () => {
    assert.deepEqual(resolverPromocaoTv(ENV_OK), {
      situacao: "ok",
      promocao: { versao: "planos-v1", videoUrl: ENV_OK.PROMOCAO_TV_VIDEO_URL, duracaoMs: DURACAO_S * 1000 },
    });
  });

  test("ausente ou inválida nunca vira promoção", () => {
    const invalidos: Record<string, string | undefined>[] = [
      {},
      { ...ENV_OK, PROMOCAO_TV_VIDEO_URL: undefined },
      { ...ENV_OK, PROMOCAO_TV_DURACAO_SEG: undefined },
      { ...ENV_OK, PROMOCAO_TV_VIDEO_URL: "http://midia.invalido/x.mp4" },
      { ...ENV_OK, PROMOCAO_TV_VIDEO_URL: "javascript:alert(1)" },
      { ...ENV_OK, PROMOCAO_TV_VIDEO_URL: "https://user:senha@midia.invalido/x.mp4" },
      { ...ENV_OK, PROMOCAO_TV_VIDEO_URL: "nao-e-url" },
      { ...ENV_OK, PROMOCAO_TV_DURACAO_SEG: String(DURACAO_MINIMA_S - 1) },
      { ...ENV_OK, PROMOCAO_TV_DURACAO_SEG: String(DURACAO_MAXIMA_S + 1) },
      { ...ENV_OK, PROMOCAO_TV_DURACAO_SEG: "30.5" },
      { ...ENV_OK, PROMOCAO_TV_DURACAO_SEG: "1e2" },
      { ...ENV_OK, PROMOCAO_TV_DURACAO_SEG: "trinta" },
      { ...ENV_OK, PROMOCAO_TV_VERSAO: "com espaço" },
    ];
    for (const env of invalidos) {
      assert.equal(resolverPromocaoTv(env).situacao, "indisponivel", JSON.stringify(env));
    }
  });

  test("a URL do vídeo não está no código de nenhum ambiente", async () => {
    const fs = await import("node:fs");
    const fonte = fs.readFileSync("src/lib/ads/promocaoTv.ts", "utf8");
    assert.equal(/https:\/\/app\.obaflix\.online\/ads\//.test(fonte), false);
    assert.equal(fonte.includes("NEXT_PUBLIC_"), true, "o aviso existe no comentário");
    assert.equal(/process\.env\.NEXT_PUBLIC_PROMOCAO/.test(fonte), false);
  });
});

describe("plataforma sai da credencial", () => {
  test("Bearer de TV é TV, declare o que declarar", () => {
    for (const declarada of ["android", "electron", "web", undefined, "android_tv"]) {
      assert.equal(plataformaDaRequisicao(declarada, TV), "android_tv", String(declarada));
    }
  });

  test("cookie que declara TV cai em web, sem meio de exibição", () => {
    assert.equal(plataformaDaRequisicao("android_tv", CELULAR), "web");
    assert.equal(normalizarPlataforma("android_tv"), "web");
    assert.equal(meioDeExibicao("web", true, true), null);
  });

  test("cookie de celular continua celular", () => {
    assert.equal(plataformaDaRequisicao("android", CELULAR), "android");
    assert.equal(plataformaDaRequisicao("electron", CELULAR), "electron");
    assert.equal(meioDeExibicao("android", false, false), "unity");
  });

  test("TV só tem meio com promoção configurada", () => {
    assert.equal(meioDeExibicao("android_tv", true, false), null);
    assert.equal(meioDeExibicao("android_tv", false, true), "promocao_tv");
  });

  test("tempo mínimo: a duração inteira, com um segundo de folga de relógio", () => {
    const d = DURACAO_S * 1000;
    assert.equal(promocaoCumprida(0, d, d), true);
    assert.equal(promocaoCumprida(0, d - TOLERANCIA_RELOGIO_PROMOCAO_MS, d), true);
    assert.equal(promocaoCumprida(0, d - TOLERANCIA_RELOGIO_PROMOCAO_MS - 1, d), false);
    assert.equal(promocaoCumprida(0, 1_000, d), false);
  });

  test("desafio de TV incoerente não é gravado", async () => {
    await assert.rejects(
      abrirDesafio({ userId: novoUsuario(), tipo: "filme", plataforma: "android_tv", alvo: ALVO_FILME }),
    );
  });
});

// ── Decisão ──────────────────────────────────────────────────────────────────

describe("/playback/authorize na TV", () => {
  test("gratuito, monetização ligada: PROMOCAO_TV_NECESSARIA com desafio e sem vídeo", async () => {
    const r = await autorizar({ userId: novoUsuario() }, FILME);
    const auth = await r.json();
    assert.equal(r.status, 200);
    assert.equal(auth.decisao, "PROMOCAO_TV_NECESSARIA");
    assert.match(auth.desafioId, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(auth.passe, undefined);
    assert.equal(JSON.stringify(auth).includes("midia.invalido"), false, "o vídeo só sai no início");
    assert.equal(r.headers.get("Cache-Control")?.includes("no-store"), true);
  });

  test("monetização desligada: PERMITIDO sem consultar entitlements, igual a hoje", async () => {
    let consultou = false;
    const r = await authorizePost.createForTest({
      ...portas({ userId: novoUsuario(), flag: false }),
      entitlementsDoUsuario: async () => {
        consultou = true;
        throw new Error("não devia consultar");
      },
      conteudoExiste: async () => {
        throw new Error("não devia consultar catálogo");
      },
    })(req(FILME));
    assert.deepEqual(await r.json(), { decisao: "PERMITIDO" });
    assert.equal(consultou, false);
  });

  test("Básico, Plus e Premium: PERMITIDO, sem desafio, sem passe, sem promoção", async () => {
    for (const plano of [PLANO_BASIC, PLANO_PLUS, PLANO_PREMIUM]) {
      for (const corpo of [FILME, { conteudoId: "serie_tv", conteudoTipo: "serie", temporada: 1, numeroEp: 3 }]) {
        const userId = novoUsuario();
        const auth = await (await autorizar({ userId, plano }, corpo)).json();
        assert.deepEqual(auth, { decisao: "PERMITIDO" }, plano.id);
        const alvo: AlvoDeConcessao = corpo.conteudoTipo === "filme"
          ? ALVO_FILME
          : { tipo: "serie", conteudoId: "serie_tv", temporada: 1, episodio: 3 };
        assert.deepEqual(await portaDeFontes(userId, plano, null, alvo), { liberado: true, via: "sem_anuncios" });
      }
    }
  });

  test("a decisão sai de direito, não do nome do plano", async () => {
    // Um plano "premium" que, por linha de banco, exigisse anúncio receberia promoção.
    const auth = await (await autorizar(
      { userId: novoUsuario(), plano: PLANO_PREMIUM, ajuste: { anunciosObrigatorios: true } },
      FILME,
    )).json();
    assert.equal(auth.decisao, "PROMOCAO_TV_NECESSARIA");
  });

  test("TV que declara android não cai no anúncio de 6 s do celular", async () => {
    const auth = await (await autorizar({ userId: novoUsuario() }, { ...FILME, plataforma: "android" })).json();
    assert.equal(auth.decisao, "PROMOCAO_TV_NECESSARIA");
  });

  test("celular publicado: cookie + android segue com ANUNCIO_NECESSARIO (Unity)", async () => {
    const auth = await (await autorizar(
      { userId: novoUsuario(), credencial: CELULAR },
      { ...FILME, plataforma: "android" },
    )).json();
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    assert.equal(typeof auth.desafioId, "string");
  });

  test("cookie que declara android_tv não recebe promoção", async () => {
    const auth = await (await autorizar(
      { userId: novoUsuario(), credencial: CELULAR },
      { ...FILME, plataforma: "android_tv" },
    )).json();
    assert.deepEqual(auth, { decisao: "ANUNCIO_INDISPONIVEL", codigo: "anuncio_indisponivel" });
  });

  test("configuração ausente ou inválida: recusa, nenhum desafio, e /fontes também recusa", async () => {
    for (const env of [{}, { ...ENV_OK, PROMOCAO_TV_VIDEO_URL: "http://x.invalido/v.mp4" }]) {
      const userId = novoUsuario();
      const auth = await (await autorizar({ userId, env }, FILME)).json();
      assert.deepEqual(auth, { decisao: "ANUNCIO_INDISPONIVEL", codigo: "anuncio_indisponivel" });
      assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, null), { liberado: false, motivo: "sem_concessao" });
    }
  });

  test("download e transmissão não têm promoção na TV", async () => {
    for (const finalidade of ["download", "transmissao"]) {
      const auth = await (await autorizar({ userId: novoUsuario() }, { ...FILME, finalidade })).json();
      assert.equal(auth.decisao, "ANUNCIO_INDISPONIVEL", finalidade);
    }
  });

  test("conteúdo inexistente: 404 antes de abrir promoção", async () => {
    let abriu = false;
    const r = await authorizePost.createForTest({
      ...portas({ userId: novoUsuario() }),
      resolverPromocaoTv: () => resolverPromocaoTv(ENV_OK),
      conteudoExiste: async () => false,
      abrirDesafio: async () => {
        abriu = true;
        return "x";
      },
    })(req(FILME));
    assert.equal(r.status, 404);
    assert.equal(abriu, false);
  });

  test("catálogo indisponível: 503 recuperável, sem desafio", async () => {
    const r = await autorizar({ userId: novoUsuario(), conteudoExiste: async () => { throw new Error("pg"); } }, FILME);
    assert.equal(r.status, 503);
  });

  test("conteúdo fora do plano: NEGADO, para a TV oferecer planos", async () => {
    const auth = await (await autorizar(
      { userId: novoUsuario(), plano: PLANO_BASIC, ajuste: { series: false } },
      { conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: 1 },
    )).json();
    assert.deepEqual(auth, { decisao: "NEGADO", codigo: "conteudo_indisponivel_no_plano" });
  });

  test("entitlements fora do ar: 503, nunca promoção nem PERMITIDO", async () => {
    const r = await authorizePost.createForTest({
      ...portas({ userId: novoUsuario() }),
      entitlementsDoUsuario: async () => { throw new Error("redis"); },
      resolverPromocaoTv: () => resolverPromocaoTv(ENV_OK),
    })(req(FILME));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).codigo, "entitlements_indisponiveis");
  });
});

// ── Sessão promocional ───────────────────────────────────────────────────────

describe("sessão promocional e concessão", () => {
  test("caminho feliz: promoção até o fim → concessão → /fontes abre o filme pedido", async () => {
    const userId = novoUsuario();
    const { concessao } = await assistirPromocao({ userId });

    const ttl = await getRedis().ttl(`ads:concessao:${concessao}`);
    assert.ok(ttl > 0 && ttl <= TTL_CONCESSAO_PROMOCAO_TV_S, `ttl curto (${ttl})`);

    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, concessao), { liberado: true, via: "concessao" });
  });

  test("o início devolve o vídeo configurado pelo servidor", async () => {
    const c = { userId: novoUsuario() };
    const auth = await (await autorizar(c, FILME)).json();
    const r = await iniciar(c, auth.desafioId, Date.now());
    assert.deepEqual(await r.json(), {
      videoUrl: ENV_OK.PROMOCAO_TV_VIDEO_URL,
      duracaoSeg: DURACAO_S,
      versao: "planos-v1",
    });
  });

  test("concessão não se reutiliza", async () => {
    const userId = novoUsuario();
    const { concessao } = await assistirPromocao({ userId });
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao)).liberado, true);
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, concessao), {
      liberado: false,
      motivo: "concessao_invalida",
    });
  });

  test("concessão de um filme não abre outro filme", async () => {
    const userId = novoUsuario();
    const { concessao } = await assistirPromocao({ userId });
    const outro: AlvoDeConcessao = { ...ALVO_FILME, conteudoId: "filme_tv_2" };
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao, outro)).liberado, false);
    // E a tentativa não queima a do dono.
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao)).liberado, true);
  });

  test("concessão de um episódio não abre outro episódio", async () => {
    const userId = novoUsuario();
    const c = { userId, plano: PLANO_GRATUITO, ajuste: { episodiosPorAnuncio: 1 } };
    const corpo = { conteudoId: "serie_tv", conteudoTipo: "serie", temporada: 2, numeroEp: 5 };
    const { concessao } = await assistirPromocao(c, corpo);
    const ep6: AlvoDeConcessao = { tipo: "serie", conteudoId: "serie_tv", temporada: 2, episodio: 6 };
    const ep5: AlvoDeConcessao = { ...ep6, episodio: 5 };
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao, ep6)).liberado, false);
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao, ep5)).liberado, true);
  });

  test("concessão de um usuário não serve a outro", async () => {
    const dono = novoUsuario();
    const { concessao } = await assistirPromocao({ userId: dono });
    assert.equal((await portaDeFontes(novoUsuario(), PLANO_GRATUITO, concessao)).liberado, false);
    assert.equal((await portaDeFontes(dono, PLANO_GRATUITO, concessao)).liberado, true);
  });

  test("concessão de reprodução não libera download nem transmissão", async () => {
    const userId = novoUsuario();
    const { concessao } = await assistirPromocao({ userId });
    for (const finalidade of ["download", "transmissao"] as const) {
      assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao, ALVO_FILME, finalidade)).liberado, false);
    }
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, concessao)).liberado, true);
  });

  test("chamada direta a /fontes, sem passar pela promoção, é recusada", async () => {
    const userId = novoUsuario();
    await autorizar({ userId }, FILME);
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, null), { liberado: false, motivo: "sem_concessao" });
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, "inventada_1234567890"), {
      liberado: false,
      motivo: "concessao_invalida",
    });
  });

  test("conclusão sem início: recusada, e o desafio queima", async () => {
    const c = { userId: novoUsuario() };
    const auth = await (await autorizar(c, FILME)).json();
    const r = await concluir(c, { desafioId: auth.desafioId, concluido: true }, Date.now() + 10 * 60_000);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).codigo, "promocao_nao_iniciada");
    // Queimado: iniciar agora não ressuscita a sessão.
    assert.equal((await iniciar(c, auth.desafioId, Date.now())).status, 403);
  });

  test("conclusão antecipada: recusada, e o desafio queima", async () => {
    const c = { userId: novoUsuario() };
    const auth = await (await autorizar(c, FILME)).json();
    const inicio = Date.now() + 7_000;
    await iniciar(c, auth.desafioId, inicio);
    const cedo = await concluir(c, { desafioId: auth.desafioId, concluido: true }, inicio + 10_000);
    assert.equal(cedo.status, 403);
    assert.equal((await cedo.json()).codigo, "anuncio_nao_concluido");
    const depois = await concluir(c, { desafioId: auth.desafioId }, inicio + DURACAO_S * 1000 + 5_000);
    assert.equal(depois.status, 403, "quem tentou cedo precisa recomeçar");
  });

  test("conclusão falsificada: assistiuAnuncio=true sem desafio não emite nada", async () => {
    const c = { userId: novoUsuario() };
    for (const corpo of [
      { assistiuAnuncio: true },
      { desafioId: "falso_000000000000000000", concluido: true, assistiuAnuncio: true },
      { desafioId: "../../ads:concessao:x" },
    ]) {
      const r = await concluir(c, corpo, Date.now() + 60_000);
      assert.ok(r.status === 400 || r.status === 403, JSON.stringify(corpo));
      assert.equal((await r.json()).concessao, undefined);
    }
  });

  test("desafio expirado: nem inicia nem conclui", async () => {
    const c = { userId: novoUsuario() };
    const auth = await (await autorizar(c, FILME)).json();
    const inicio = Date.now() + 7_000;
    await iniciar(c, auth.desafioId, inicio);
    await getRedis().del(`ads:desafio:${auth.desafioId}`);
    assert.equal((await iniciar(c, auth.desafioId, inicio)).status, 403);
    assert.equal((await concluir(c, { desafioId: auth.desafioId }, inicio + DURACAO_S * 1000 + 1)).status, 403);
  });

  test("outro aparelho, outra conta ou cookie da mesma conta não iniciam nem concluem", async () => {
    const userId = novoUsuario();
    const c = { userId };
    const auth = await (await autorizar(c, FILME)).json();
    const inicio = Date.now() + 7_000;

    assert.equal((await iniciar({ userId, credencial: OUTRA_TV }, auth.desafioId, inicio)).status, 403);
    assert.equal((await iniciar({ userId, credencial: CELULAR }, auth.desafioId, inicio)).status, 403);
    assert.equal((await iniciar({ userId: novoUsuario() }, auth.desafioId, inicio)).status, 403);

    // As tentativas alheias não queimam o desafio: o dono segue.
    assert.equal((await iniciar(c, auth.desafioId, inicio)).status, 200);

    const fim = inicio + DURACAO_S * 1000 + 1;
    const alheio = await concluir({ userId, credencial: OUTRA_TV }, { desafioId: auth.desafioId }, fim);
    assert.equal(alheio.status, 403);
    assert.equal((await alheio.json()).concessao, undefined);
  });

  test("retry do início não reinicia a contagem", async () => {
    const c = { userId: novoUsuario() };
    const auth = await (await autorizar(c, FILME)).json();
    const inicio = Date.now() + 7_000;
    await iniciar(c, auth.desafioId, inicio);
    // Retry 25 s depois: se reiniciasse, a conclusão abaixo seria antecipada.
    assert.equal((await iniciar(c, auth.desafioId, inicio + 25_000)).status, 200);
    const r = await concluir(c, { desafioId: auth.desafioId }, inicio + DURACAO_S * 1000 + 1);
    assert.equal(r.status, 200);
  });

  test("retry da conclusão não gera segunda concessão; nova pergunta recebe passe pela marca de pago", async () => {
    const userId = novoUsuario();
    const c = { userId };
    const { desafioId, inicio } = await assistirPromocao(c);

    const repetida = await concluir(c, { desafioId }, inicio + DURACAO_S * 1000 + 2_000);
    assert.equal(repetida.status, 403);
    assert.equal((await repetida.json()).concessao, undefined);

    // A resposta da conclusão se perdeu? A TV pergunta de novo e não assiste outra vez.
    const auth = await (await autorizar(c, FILME)).json();
    assert.equal(auth.decisao, "PERMITIDO");
    assert.equal(typeof auth.passe, "string");
    assert.equal((await portaDeFontes(userId, PLANO_GRATUITO, auth.passe)).liberado, true);
  });

  test("interrupção: abandonar a promoção não libera nada", async () => {
    const userId = novoUsuario();
    const c = { userId };
    const auth = await (await autorizar(c, FILME)).json();
    await iniciar(c, auth.desafioId, Date.now());
    // Voltar/fechar o player: a TV não conclui. O conteúdo segue fechado.
    assert.deepEqual(await portaDeFontes(userId, PLANO_GRATUITO, null), { liberado: false, motivo: "sem_concessao" });
    // E voltar a pedir abre outra promoção, não um passe.
    assert.equal((await (await autorizar(c, FILME)).json()).decisao, "PROMOCAO_TV_NECESSARIA");
  });

  test("com a monetização desligada, iniciar e concluir não existem", async () => {
    const c = { userId: novoUsuario(), flag: false };
    assert.equal((await iniciar(c, "qualquer_desafio_1234", Date.now())).status, 404);
    assert.equal((await concluir(c, { desafioId: "qualquer_desafio_1234" }, Date.now())).status, 404);
  });

  test("concluir desafio de celular continua exigindo só o tempo mínimo de antes", async () => {
    const userId = novoUsuario();
    const c = { userId, credencial: CELULAR };
    const auth = await (await autorizar(c, { ...FILME, plataforma: "android" })).json();
    const r = await concluir(c, { desafioId: auth.desafioId }, Date.now() + 7_000);
    assert.equal(r.status, 200);
  });
});

// ── Canais: o que a TV precisa para oferecer planos ──────────────────────────

describe("/api/canais: incluidoNoPlano", () => {
  const catalogo = (nivel: string) =>
    canaisGet.createForTest({
      clientIp: () => "1.1.1.1",
      isIpBlocked: async () => false,
      getUserFromRequest: async () => ({ userId: "u" }),
      nivelDaConta: async () => nivel,
      listarCanais: async ({ nivelDaConta }) =>
        nivelDaConta === "nenhum" ? [] : [{ id: "c1" } as never],
      categoriasComCanais: async () => [],
    })(new NextRequest("https://obaflix.test/api/canais"));

  test("gratuito e Básico: lista vazia e incluidoNoPlano=false", async () => {
    for (const plano of [PLANO_GRATUITO, PLANO_BASIC]) {
      const corpo = await (await catalogo(plano.canaisNivel)).json();
      assert.deepEqual(corpo.canais, [], plano.id);
      assert.equal(corpo.incluidoNoPlano, false, plano.id);
    }
  });

  test("Plus e Premium preservam canais", async () => {
    for (const plano of [PLANO_PLUS, PLANO_PREMIUM]) {
      const corpo = await (await catalogo(plano.canaisNivel)).json();
      assert.equal(corpo.canais.length, 1, plano.id);
      assert.equal(corpo.incluidoNoPlano, true, plano.id);
    }
  });
});
