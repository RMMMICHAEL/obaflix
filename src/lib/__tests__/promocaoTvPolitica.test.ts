import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { POST as authorizePost } from "@/app/api/playback/authorize/route";
import { POST as completePost } from "@/app/api/ads/complete/route";
import { POST as iniciarPost } from "@/app/api/ads/promocao/iniciar/route";
import { autorizarPorAnuncio } from "../ads/enforcement";
import {
  TTL_CONCESSAO_PROMOCAO_TV_S,
  TTL_RECUPERACAO_TV_S,
  episodiosDistintosNaJanela,
  type AlvoDeConcessao,
} from "../ads/concessoes";
import { decidirPromocaoTv } from "../ads/politica";
import { resolverPromocaoTv } from "../ads/promocaoTv";
import { PLANO_GRATUITO, PLANO_PLUS } from "../planos";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

/**
 * A política de frequência da TV: promoção antes de cada filme ou episódio
 * novo, separada da cadência do celular, com recuperação só no mesmo aparelho.
 *
 * Pelas rotas reais, com o Redis em memória. Sessão, entitlements, catálogo e
 * relógio entram por injeção.
 */

function direitosDe(plano: PlanoSemeado): DireitosDoPlano {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...direitos } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return direitos as DireitosDoPlano;
}
const entitlementsDe = (plano: PlanoSemeado): Entitlements => ({
  assinatura: { ativa: plano.id !== "gratuito", planoId: plano.id, expiraEm: null },
  direitos: direitosDe(plano),
});

let seq = 0;
const novoUsuario = () => `u_tvpol_${Date.now()}_${++seq}`;

const DURACAO_S = 20;
const ENV = { PROMOCAO_TV_VIDEO_URL: "https://midia.invalido/p.mp4", PROMOCAO_TV_DURACAO_SEG: String(DURACAO_S) };

type Credencial = { origem: "cookie" | "bearer"; deviceId: string | null };
const TV_SALA: Credencial = { origem: "bearer", deviceId: "tv_sala" };
const TV_QUARTO: Credencial = { origem: "bearer", deviceId: "tv_quarto" };
const CELULAR: Credencial = { origem: "cookie", deviceId: null };

type Req = Parameters<typeof authorizePost>[0];
const req = (corpo: unknown): Req =>
  new Request("https://obaflix.test/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  }) as unknown as Req;

const portas = (userId: string, credencial: Credencial, plano: PlanoSemeado = PLANO_GRATUITO) => ({
  getUserFromRequest: async () => ({ userId, role: "user", ...credencial }),
  monetizacaoAtiva: () => true,
  entitlementsDoUsuario: async () => entitlementsDe(plano),
  isIpBlocked: async () => false,
  recordAbuseAttempt: async () => {},
});

const autorizar = (userId: string, credencial: Credencial, corpo: Record<string, unknown>, plano?: PlanoSemeado) =>
  authorizePost
    .createForTest({
      ...portas(userId, credencial, plano),
      resolverDirectLink: () => ({ situacao: "indisponivel" }),
      resolverPromocaoTv: () => resolverPromocaoTv(ENV),
      conteudoExiste: async () => true,
    })(req(credencial === CELULAR ? { ...corpo, plataforma: "android" } : corpo))
    .then((r) => r.json());

const iniciar = (userId: string, credencial: Credencial, desafioId: string, agora: number) =>
  iniciarPost.createForTest({
    ...portas(userId, credencial),
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    agora: () => agora,
  })(req({ desafioId }));

const concluir = (userId: string, credencial: Credencial, desafioId: string, agora: number) =>
  completePost.createForTest({
    ...portas(userId, credencial),
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    agora: () => agora,
  })(req({ desafioId, concluido: true }));

const fontes = (userId: string, concessao: string | null, alvo: AlvoDeConcessao) =>
  autorizarPorAnuncio(
    { userId, tipo: alvo.tipo, concessao, finalidade: "reproducao", alvo },
    { ativa: true, resolver: async () => entitlementsDe(PLANO_GRATUITO) },
  );

const ep = (episodio: number) => ({ conteudoId: "serie_pol", conteudoTipo: "serie", temporada: 1, numeroEp: episodio });
const alvoEp = (episodio: number): AlvoDeConcessao => ({ tipo: "serie", conteudoId: "serie_pol", temporada: 1, episodio });
const FILME = { conteudoId: "filme_pol", conteudoTipo: "filme" };
const ALVO_FILME: AlvoDeConcessao = { tipo: "filme", conteudoId: "filme_pol", temporada: null, episodio: null };

/** Assiste a promoção inteira neste aparelho e devolve a concessão. */
async function assistir(userId: string, credencial: Credencial, corpo: Record<string, unknown>) {
  const auth = await autorizar(userId, credencial, corpo);
  assert.equal(auth.decisao, "PROMOCAO_TV_NECESSARIA");
  const inicio = Date.now() + 1_000;
  assert.equal((await iniciar(userId, credencial, auth.desafioId, inicio)).status, 200);
  const r = await concluir(userId, credencial, auth.desafioId, inicio + DURACAO_S * 1000 + 500);
  assert.equal(r.status, 200);
  return (await r.json()).concessao as string;
}

// ── Regra pura ───────────────────────────────────────────────────────────────

describe("decidirPromocaoTv", () => {
  const gratuito = direitosDe(PLANO_GRATUITO);

  test("gratuito: promoção em toda reprodução, sem cota", () => {
    assert.deepEqual(
      decidirPromocaoTv({ direitos: gratuito, finalidade: "reproducao", liberadoNesteAparelho: false }),
      { decisao: "promocao_necessaria" },
    );
  });

  test("recuperação no aparelho libera; download e transmissão não têm meio", () => {
    assert.equal(
      decidirPromocaoTv({ direitos: gratuito, finalidade: "reproducao", liberadoNesteAparelho: true }).decisao,
      "permitido",
    );
    for (const finalidade of ["download", "transmissao"] as const) {
      assert.deepEqual(
        decidirPromocaoTv({ direitos: gratuito, finalidade, liberadoNesteAparelho: true }),
        { decisao: "sem_meio" },
      );
    }
  });

  test("assinante nunca vê promoção, e isso sai do direito", () => {
    assert.deepEqual(
      decidirPromocaoTv({ direitos: direitosDe(PLANO_PLUS), finalidade: "reproducao", liberadoNesteAparelho: false }),
      { decisao: "permitido", via: "sem_anuncios" },
    );
  });

  test("concessão curta e marca de recuperação têm papéis e prazos diferentes", () => {
    assert.equal(TTL_CONCESSAO_PROMOCAO_TV_S, 5 * 60);
    assert.equal(TTL_RECUPERACAO_TV_S, 30 * 60);
  });
});

// ── Frequência ───────────────────────────────────────────────────────────────

describe("frequência na TV", () => {
  test("cada episódio novo pede promoção — não herda a cota de três do celular", async () => {
    const userId = novoUsuario();
    for (const n of [1, 2, 3, 4]) {
      assert.equal((await autorizar(userId, TV_SALA, ep(n))).decisao, "PROMOCAO_TV_NECESSARIA", `episódio ${n}`);
    }
  });

  test("celular mantém a cadência dele: 1º e 2º passam, 3º pede anúncio", async () => {
    const userId = novoUsuario();
    assert.equal((await autorizar(userId, CELULAR, ep(1))).decisao, "PERMITIDO");
    assert.equal((await autorizar(userId, CELULAR, ep(2))).decisao, "PERMITIDO");
    assert.equal((await autorizar(userId, CELULAR, ep(3))).decisao, "ANUNCIO_NECESSARIO");
  });

  test("promoção cancelada não some ao pedir outro episódio e voltar", async () => {
    const userId = novoUsuario();

    // 1. o episódio 1 exige promoção
    const a = await autorizar(userId, TV_SALA, ep(1));
    assert.equal(a.decisao, "PROMOCAO_TV_NECESSARIA");

    // 2. a pessoa começa e cancela sem concluir
    assert.equal((await iniciar(userId, TV_SALA, a.desafioId, Date.now() + 1_000)).status, 200);

    // 3. pede outro episódio
    const b = await autorizar(userId, TV_SALA, ep(2));
    assert.equal(b.decisao, "PROMOCAO_TV_NECESSARIA");

    // 4. volta ao episódio anterior: a promoção continua exigida
    const deNovo = await autorizar(userId, TV_SALA, ep(1));
    assert.equal(deNovo.decisao, "PROMOCAO_TV_NECESSARIA");
    assert.notEqual(deNovo.desafioId, a.desafioId, "é um desafio novo, não o cancelado reaproveitado");
    assert.equal(deNovo.passe, undefined);

    // e nada abre o conteúdo sem concluir
    assert.deepEqual(await fontes(userId, null, alvoEp(1)), { liberado: false, motivo: "sem_concessao" });
  });

  test("recuperação vale para o mesmo conteúdo no mesmo aparelho, e só para ele", async () => {
    const userId = novoUsuario();
    const concessao = await assistir(userId, TV_SALA, ep(1));
    assert.equal((await fontes(userId, concessao, alvoEp(1))).liberado, true);

    const volta = await autorizar(userId, TV_SALA, ep(1));
    assert.equal(volta.decisao, "PERMITIDO", "mesmo aparelho, mesmo episódio: recupera");
    assert.equal(typeof volta.passe, "string");
    assert.equal((await fontes(userId, volta.passe, alvoEp(1))).liberado, true);

    assert.equal((await autorizar(userId, TV_SALA, ep(2))).decisao, "PROMOCAO_TV_NECESSARIA", "outro episódio");
    assert.equal((await autorizar(userId, TV_QUARTO, ep(1))).decisao, "PROMOCAO_TV_NECESSARIA", "outra TV da conta");
  });
});

// ── Interferência entre plataformas ──────────────────────────────────────────

describe("plataformas da mesma conta não se liberam", () => {
  test("TV não consome a cota de episódios do celular", async () => {
    const userId = novoUsuario();
    for (const n of [1, 2, 3]) await autorizar(userId, TV_SALA, ep(n));
    assert.equal(await episodiosDistintosNaJanela(userId), 0);
    assert.equal((await autorizar(userId, CELULAR, ep(1))).decisao, "PERMITIDO");
  });

  test("anúncio concluído no celular não dispensa a promoção da TV", async () => {
    const userId = novoUsuario();
    const auth = await autorizar(userId, CELULAR, FILME);
    assert.equal(auth.decisao, "ANUNCIO_NECESSARIO");
    assert.equal((await concluir(userId, CELULAR, auth.desafioId, Date.now() + 7_000)).status, 200);

    assert.equal((await autorizar(userId, CELULAR, FILME)).decisao, "PERMITIDO", "o celular recupera o dele");
    assert.equal((await autorizar(userId, TV_SALA, FILME)).decisao, "PROMOCAO_TV_NECESSARIA");
  });

  test("promoção concluída na TV não dispensa o anúncio do celular", async () => {
    const userId = novoUsuario();
    await assistir(userId, TV_SALA, FILME);
    assert.equal((await autorizar(userId, CELULAR, FILME)).decisao, "ANUNCIO_NECESSARIO");
  });

  test("desafio da TV não é concluído pelo celular da mesma conta", async () => {
    const userId = novoUsuario();
    const auth = await autorizar(userId, TV_SALA, FILME);
    const inicio = Date.now() + 1_000;
    await iniciar(userId, TV_SALA, auth.desafioId, inicio);
    const r = await concluir(userId, CELULAR, auth.desafioId, inicio + DURACAO_S * 1000 + 500);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).concessao, undefined);
  });
});

// ── Concorrência ─────────────────────────────────────────────────────────────

describe("requisições concorrentes", () => {
  test("pedidos paralelos do mesmo conteúdo: cada um exige a sua promoção", async () => {
    const userId = novoUsuario();
    const respostas = await Promise.all(Array.from({ length: 5 }, () => autorizar(userId, TV_SALA, FILME)));
    assert.ok(respostas.every((r) => r.decisao === "PROMOCAO_TV_NECESSARIA"));
    assert.equal(new Set(respostas.map((r) => r.desafioId)).size, 5);
  });

  test("conclusões paralelas do mesmo desafio: exatamente uma concessão", async () => {
    const userId = novoUsuario();
    const auth = await autorizar(userId, TV_SALA, FILME);
    const inicio = Date.now() + 1_000;
    await iniciar(userId, TV_SALA, auth.desafioId, inicio);
    const fim = inicio + DURACAO_S * 1000 + 500;
    const rs = await Promise.all(Array.from({ length: 5 }, () => concluir(userId, TV_SALA, auth.desafioId, fim)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
  });

  test("inícios paralelos gravam um instante só", async () => {
    const userId = novoUsuario();
    const auth = await autorizar(userId, TV_SALA, FILME);
    const base = Date.now() + 1_000;
    const rs = await Promise.all([0, 5_000, 10_000].map((d) => iniciar(userId, TV_SALA, auth.desafioId, base + d)));
    assert.ok(rs.every((r) => r.status === 200));
    // Se algum retry tivesse regravado o início 10 s depois, esta conclusão seria antecipada.
    const r = await concluir(userId, TV_SALA, auth.desafioId, base + DURACAO_S * 1000);
    assert.equal(r.status, 200);
  });

  test("uso paralelo da concessão em /fontes: exatamente um abre", async () => {
    const userId = novoUsuario();
    const concessao = await assistir(userId, TV_SALA, FILME);
    const rs = await Promise.all(Array.from({ length: 5 }, () => fontes(userId, concessao, ALVO_FILME)));
    assert.equal(rs.filter((r) => r.liberado).length, 1);
  });

  test("TV conclui enquanto o celular pede o mesmo filme: o celular segue cobrado", async () => {
    const userId = novoUsuario();
    const auth = await autorizar(userId, TV_SALA, FILME);
    const inicio = Date.now() + 1_000;
    await iniciar(userId, TV_SALA, auth.desafioId, inicio);
    const [tv, celular] = await Promise.all([
      concluir(userId, TV_SALA, auth.desafioId, inicio + DURACAO_S * 1000 + 500),
      autorizar(userId, CELULAR, FILME),
    ]);
    assert.equal(tv.status, 200);
    assert.equal(celular.decisao, "ANUNCIO_NECESSARIO");
  });
});
