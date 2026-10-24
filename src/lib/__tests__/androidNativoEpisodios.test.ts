import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { POST as authorizePost } from "@/app/api/playback/authorize/route";
import { POST as completePost } from "@/app/api/ads/complete/route";
import { decidirAnuncio } from "../ads/politica";
import { PLANO_GRATUITO, PLANO_PREMIUM } from "../planos";
import { TEMPO_MINIMO_DE_ANUNCIO_MS } from "../ads/concessoes";
import type { Entitlements } from "../entitlements";
import type { DireitosDoPlano, PlanoSemeado } from "../planos";

const direitosDe = (plano: PlanoSemeado): DireitosDoPlano => {
  const { id, nome, descricao, ordem, ativo, ehPadrao, ...d } = plano;
  void [id, nome, descricao, ordem, ativo, ehPadrao];
  return d as DireitosDoPlano;
};
const entitlementsDe = (plano: PlanoSemeado): Entitlements => ({
  assinatura: { ativa: plano.id !== "gratuito", planoId: plano.id, expiraEm: null },
  direitos: direitosDe(plano),
});

let seq = 0;
const novoUsuario = () => `u_nativo_ep_${Date.now()}_${++seq}`;

const NATIVO = { "x-obaflix-client": "android-nativo", "user-agent": "ObaflixNative/0.6.3" };
const req = (corpo: unknown, headers: Record<string, string> = NATIVO) =>
  new Request("https://obaflix.test/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(corpo),
  }) as unknown as Parameters<ReturnType<typeof authorizePost.createForTest>>[0];

const portas = (userId: string, plano: PlanoSemeado) => ({
  getUserFromRequest: async () => ({ userId, role: "user", origem: "cookie" as const, deviceId: null }),
  monetizacaoAtiva: () => false,
  anuncioAndroidAtivo: () => true, // WebView ligado: não pode mudar o que o nativo cobra nem o contrário
  anuncioAndroidNativoAtivo: () => true,
  entitlementsDoUsuario: async () => entitlementsDe(plano),
  isIpBlocked: async () => false,
  recordAbuseAttempt: async () => {},
});
const autorizar = (userId: string, plano = PLANO_GRATUITO) => authorizePost.createForTest(portas(userId, plano));
const concluir = (userId: string, plano = PLANO_GRATUITO) =>
  completePost.createForTest({
    ...portas(userId, plano),
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    agora: () => Date.now() + TEMPO_MINIMO_DE_ANUNCIO_MS + 500,
  });

const serie = (ep: number, plataforma = "android_nativo", headers?: Record<string, string>) =>
  req({ conteudoId: "s1", conteudoTipo: "serie", temporada: 1, numeroEp: ep, plataforma }, headers);
const filme = (id = "f1") => req({ conteudoId: id, conteudoTipo: "filme", plataforma: "android_nativo" });
const decisao = async (r: Response | Promise<Response>) => (await (await r).json()).decisao as string;

describe("Android nativo: um anúncio por episódio novo", () => {
  test("episódios consecutivos de série ou anime pedem anúncio, sem cota de 3", async () => {
    const u = novoUsuario();
    const h = autorizar(u);
    for (const ep of [1, 2, 3, 4, 5]) assert.equal(await decisao(h(serie(ep))), "ANUNCIO_NECESSARIO", `ep ${ep}`);
  });

  test("filme novo pede anúncio", async () => {
    assert.equal(await decisao(autorizar(novoUsuario())(filme())), "ANUNCIO_NECESSARIO");
  });

  test("concessão válida não repete o anúncio ao reabrir o mesmo episódio ou filme", async () => {
    const u = novoUsuario();
    const a = await (await autorizar(u)(serie(1))).json();
    assert.equal(a.decisao, "ANUNCIO_NECESSARIO");
    const c = await concluir(u)(req({ desafioId: a.desafioId }));
    assert.equal(c.status, 200);
    assert.equal(await decisao(autorizar(u)(serie(1))), "PERMITIDO"); // reabrir/retomar
    assert.equal(await decisao(autorizar(u)(serie(2))), "ANUNCIO_NECESSARIO"); // o próximo é outro episódio
  });

  test("conta isenta não recebe anúncio", async () => {
    const h = autorizar(novoUsuario(), PLANO_PREMIUM);
    assert.equal(await decisao(h(serie(1))), "PERMITIDO");
    assert.equal(await decisao(h(serie(2))), "PERMITIDO");
    assert.equal(await decisao(h(filme())), "PERMITIDO");
  });

  test("o WebView (android) mantém a cota de 3 e o nativo não mexe no contador dele", async () => {
    const u = novoUsuario();
    for (const ep of [1, 2, 3, 4]) await autorizar(u)(serie(ep)); // nativo: não conta
    const web = autorizar(u);
    const w = (ep: number) => decisao(web(serie(ep, "android", {})));
    assert.equal(await w(1), "PERMITIDO");
    assert.equal(await w(2), "PERMITIDO");
    assert.equal(await w(3), "ANUNCIO_NECESSARIO");
  });

  test("declarar android_nativo sem os sinais do app cai em web: não cobra nem muda o WebView", async () => {
    const u = novoUsuario();
    const r = await decisao(autorizar(u)(serie(1, "android_nativo", {})));
    assert.equal(r, "PERMITIDO"); // `web` sem monetização global: mesmo resultado de declarar web hoje
  });

  test("política pura: todoEpisodio só vale quando pedido", () => {
    const d = direitosDe(PLANO_GRATUITO);
    const base = { direitos: d, tipo: "serie" as const, temConcessao: false, episodiosDistintosNaJanela: 1 };
    assert.equal(decidirAnuncio(base).decisao, "permitido");
    assert.equal(decidirAnuncio({ ...base, todoEpisodio: true }).decisao, "anuncio_necessario");
    assert.equal(decidirAnuncio({ ...base, todoEpisodio: true, temConcessao: true }).decisao, "permitido");
  });
});
