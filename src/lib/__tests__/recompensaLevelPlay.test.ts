import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { POST as completePost } from "@/app/api/ads/complete/route";
import { POST as prepararPost } from "@/app/api/ads/levelplay/preparar/route";
import { GET as callbackGet } from "@/app/api/ads/levelplay/callback/route";
import { GET as estadoGet } from "@/app/api/ads/levelplay/estado/route";
import { GET as identidadeGet } from "@/app/api/ads/levelplay/identidade/route";
import {
  IPS_DO_LEVELPLAY,
  RecompensaEmAndamento,
  assinaturaDoEvento,
  cancelarRecompensa,
  estadoDaRecompensa,
  identidadeDoLevelPlay,
  limparRecompensa,
  modoDoDesafio,
  prepararRecompensa,
  processarCallbackLevelPlay,
  reciboDoDesafio,
  type ArmazemDeRecompensa,
} from "../ads/recompensaLevelPlay";
import { abrirDesafio, espiarDesafio } from "../ads/concessoes";
import { NextRequest } from "next/server";

/**
 * Rewarded do player confirmado por S2S. Armazém em memória e chave de TESTE gerada aqui: nenhuma credencial
 * real existe neste arquivo nem no repositório.
 *
 * Modelo: o USER_ID assinado é a identidade da conta (emitida pelo backend e entregue ao `withUserId`); o
 * `dynamicUserId` só vale junto com ela e só para o único desafio pendente da conta.
 */

const CHAVE = "k".repeat(40);
const IP_OK = IPS_DO_LEVELPLAY[0];
const AGORA = Date.UTC(2026, 9, 23, 3, 0);
const ENV = { LEVELPLAY_S2S_RECEIVER_ENABLED: "true", LEVELPLAY_S2S_PRIVATE_KEY: CHAVE, ANUNCIO_REWARDED_PLAYER_ATIVO: "true" };

interface Memoria extends ArmazemDeRecompensa {
  dados: Map<string, string>;
  falhar: { set: boolean };
  operacoes: { n: number };
  latenciaMs: { v: number };
}

function memoria(): Memoria {
  const dados = new Map<string, string>();
  const falhar = { set: false };
  const operacoes = { n: 0 };
  const latenciaMs = { v: 0 };
  const atraso = () => (latenciaMs.v ? new Promise((r) => setTimeout(r, latenciaMs.v)) : Promise.resolve());
  return {
    dados, falhar, operacoes, latenciaMs,
    get: async (k) => { operacoes.n++; await atraso(); return dados.get(k) ?? null; },
    set: async (k, v, o) => {
      operacoes.n++; await atraso();
      if (falhar.set) throw new Error("redis fora");
      if (o?.nx && dados.has(k)) return null;
      dados.set(k, v);
      return "OK";
    },
    del: async (k) => { operacoes.n++; return dados.delete(k) ? 1 : 0; },
  };
}

function ts(d = AGORA): string {
  const x = new Date(d);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${x.getUTCFullYear()}${p(x.getUTCMonth() + 1)}${p(x.getUTCDate())}${p(x.getUTCHours())}${p(x.getUTCMinutes())}`;
}

/** Query de um callback legítimo: USER_ID assinado = identidade da conta; dynamicUserId = segredo do desafio. */
function query(lpUid: string, dynamicUserId: string | null, over: Record<string, string> = {}, omit: string[] = []): URLSearchParams {
  const base: Record<string, string> = { applicationUserId: lpUid, eventId: "evt0001", rewards: "1", timestamp: ts() };
  const c = { ...base, ...over };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(c)) q.set(k, v);
  q.set("signature", over.signature ?? assinaturaDoEvento({ timestamp: c.timestamp, eventId: c.eventId, userId: c.applicationUserId, rewards: c.rewards }, CHAVE));
  if (dynamicUserId !== null) q.set("dynamicUserId", dynamicUserId);
  for (const o of omit) q.delete(o);
  return q;
}

const callback = (store: ArmazemDeRecompensa, q: URLSearchParams, extra: { ip?: string; env?: Record<string, string | undefined>; agora?: number } = {}) =>
  processarCallbackLevelPlay({ query: q, ip: extra.ip ?? IP_OK, agora: extra.agora ?? AGORA, env: extra.env ?? ENV }, store);

/** Uma conta com identidade e um desafio Rewarded pendente. */
async function conta(s: ArmazemDeRecompensa, userId: string, desafioId: string) {
  const lpUid = await identidadeDoLevelPlay(userId, s);
  const { dynamicUserId } = await prepararRecompensa({ userId, desafioId }, s);
  return { lpUid, dynamicUserId };
}

describe("identidade da conta no LevelPlay", () => {
  test("estável por conta, opaca, diferente entre contas e sem dado pessoal", async () => {
    const s = memoria();
    const a1 = await identidadeDoLevelPlay("conta-a@exemplo.com", s);
    const a2 = await identidadeDoLevelPlay("conta-a@exemplo.com", s);
    const b = await identidadeDoLevelPlay("conta-b", s);
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
    assert.match(a1, /^[0-9a-f]{32}$/);
    assert.ok(!a1.includes("conta"));
  });

  test("a rota entrega só a identidade da própria conta e só com as flags e a chave", async () => {
    const s = memoria();
    const h = (userId: string | null, env: Record<string, string | undefined> = ENV) =>
      identidadeGet.createForTest({
        getUserFromRequest: async () => (userId ? { userId, role: "user", origem: "cookie" as const, deviceId: null } : null),
        checkRateLimit: async () => ({ allowed: true, remaining: 9 }),
        identidadeDoLevelPlay: (u) => identidadeDoLevelPlay(u, s),
        env,
      });
    const req = () => new NextRequest("https://obaflix.test/api/ads/levelplay/identidade");
    const r = await h("u1")(req());
    assert.equal(r.status, 200);
    assert.equal((await r.json()).userId, await identidadeDoLevelPlay("u1", s));
    assert.equal((await h(null)(req())).status, 401);
    assert.equal((await h("u1", { ...ENV, ANUNCIO_REWARDED_PLAYER_ATIVO: "false" })(req())).status, 404);
    assert.equal((await h("u1", { ...ENV, LEVELPLAY_S2S_PRIVATE_KEY: undefined })(req())).status, 404);
  });
});

describe("callback S2S do LevelPlay", () => {
  test("evento assinado + conta + segredo do desafio pendente: ACK só depois de persistir", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    const r = await callback(s, query(lpUid, dynamicUserId));
    assert.deepEqual([r.status, r.ack, r.corpo], [200, true, "evt0001:OK"]);
    assert.equal((await reciboDoDesafio("d1", s))?.eventId, "evt0001");
  });

  test("assinatura errada, campo adulterado ou repetido: 4xx sem ACK e sem recibo", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    const adulterada = query(lpUid, dynamicUserId);
    adulterada.set("rewards", "9"); // assinou com 1
    const cases = [query(lpUid, dynamicUserId, { signature: "0".repeat(32) }), query(lpUid, dynamicUserId, { signature: "zz" }), adulterada];
    for (const q of cases) {
      const r = await callback(s, q);
      assert.equal(r.ack, false);
      assert.ok(r.status >= 400 && r.status < 500, String(r.status));
    }
    const dupla = query(lpUid, dynamicUserId);
    dupla.append("eventId", "evt0002");
    assert.equal((await callback(s, dupla)).status, 400);
    assert.equal(await reciboDoDesafio("d1", s), null);
  });

  test("o dynamicUserId sozinho não basta, e a assinatura sozinha também não", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    assert.equal((await callback(s, query(lpUid, null))).status, 400, "sem dynamicUserId");
    assert.equal((await callback(s, query(lpUid, "a".repeat(48)))).status, 409, "segredo errado");
    // USER_ID inventado, mas com o segredo certo e uma assinatura que bate: a conta não existe
    assert.equal((await callback(s, query("b".repeat(32), dynamicUserId))).status, 400);
    // o segredo no lugar do USER_ID não é uma identidade
    assert.equal((await callback(s, query(dynamicUserId, dynamicUserId))).status, 400);
    assert.equal(await reciboDoDesafio("d1", s), null);
  });

  test("troca de conta: o evento de uma conta nunca paga o desafio de outra", async () => {
    const s = memoria();
    const a = await conta(s, "ua", "da");
    const b = await conta(s, "ub", "db");
    // identidade da conta A com o segredo do desafio de B (e o inverso)
    assert.equal((await callback(s, query(a.lpUid, b.dynamicUserId, { eventId: "evtA" }))).ack, false);
    assert.equal((await callback(s, query(b.lpUid, a.dynamicUserId, { eventId: "evtB" }))).ack, false);
    assert.equal(await reciboDoDesafio("da", s), null);
    assert.equal(await reciboDoDesafio("db", s), null);
    // cada par certo paga o seu
    assert.ok((await callback(s, query(a.lpUid, a.dynamicUserId, { eventId: "evtA" }))).ack);
    assert.equal((await reciboDoDesafio("da", s))?.eventId, "evtA");
    assert.equal(await reciboDoDesafio("db", s), null);
  });

  test("desafios concorrentes: só um Rewarded pendente por conta; o mesmo desafio é idempotente", async () => {
    const s = memoria();
    const p1 = await prepararRecompensa({ userId: "u1", desafioId: "d1" }, s);
    const p1b = await prepararRecompensa({ userId: "u1", desafioId: "d1" }, s);
    assert.equal(p1.dynamicUserId, p1b.dynamicUserId);
    await assert.rejects(prepararRecompensa({ userId: "u1", desafioId: "d2" }, s), RecompensaEmAndamento);
    assert.equal(await modoDoDesafio("d2", s), null, "o segundo desafio não foi travado");
    // outra conta não é afetada
    await prepararRecompensa({ userId: "u2", desafioId: "d3" }, s);
    // concluído o primeiro, a conta pode preparar outro
    await limparRecompensa("d1", "u1", s);
    await prepararRecompensa({ userId: "u1", desafioId: "d2" }, s);
    // e limpar um desafio antigo não derruba o pendente do novo
    await limparRecompensa("d1", "u1", s);
    assert.deepEqual(await estadoDaRecompensa({ userId: "u1", desafioId: "d2" }, s), { preparado: true, confirmada: false });
  });

  test("cancelar libera o slot sem destravar o desafio; evento tardio do cancelado é recusado; com recibo não cancela", async () => {
    const s = memoria();
    const a = await conta(s, "u1", "d1");
    assert.deepEqual(await cancelarRecompensa({ userId: "outro", desafioId: "d1" }, s), { cancelada: false }, "só o dono");
    assert.deepEqual(await cancelarRecompensa({ userId: "u1", desafioId: "d1" }, s), { cancelada: true });
    assert.equal(await modoDoDesafio("d1", s), "rewarded", "o desafio continua travado: nunca vira Interstitial");
    const tardio = await callback(s, query(a.lpUid, a.dynamicUserId));
    assert.deepEqual([tardio.status, tardio.ack], [409, false]);
    const b = await prepararRecompensa({ userId: "u1", desafioId: "d2" }, s); // a conta pode tentar de novo
    assert.notEqual(b.dynamicUserId, a.dynamicUserId);
    await callback(s, query(a.lpUid, b.dynamicUserId, { eventId: "evtB" }));
    assert.deepEqual(await cancelarRecompensa({ userId: "u1", desafioId: "d2" }, s), { cancelada: false }, "recibo gravado: a confirmação vale");
    assert.ok(await reciboDoDesafio("d2", s));
  });

  test("App Key opcional: com ela configurada, evento sem a chave certa é recusado", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    const env = { ...ENV, LEVELPLAY_APP_KEY: "appchave1" };
    const sem = query(lpUid, dynamicUserId);
    assert.equal((await callback(s, sem, { env })).status, 400);
    const errada = query(lpUid, dynamicUserId); errada.set("appKey", "outroapp");
    assert.equal((await callback(s, errada, { env })).status, 400);
    const certa = query(lpUid, dynamicUserId); certa.set("appKey", "appchave1");
    assert.ok((await callback(s, certa, { env })).ack);
  });

  test("duplicado idêntico: ACK de novo e um recibo só; reentrega tardia, depois de consumido, continua em ACK", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    assert.ok((await callback(s, query(lpUid, dynamicUserId))).ack);
    assert.ok((await callback(s, query(lpUid, dynamicUserId))).ack);
    await limparRecompensa("d1", "u1", s); // /ads/complete já consumiu o desafio
    const tardia = await callback(s, query(lpUid, dynamicUserId));
    assert.ok(tardia.ack, "senão o LevelPlay repetiria por 8 dias");
    assert.equal(await reciboDoDesafio("d1", s), null, "e não recria o recibo");
  });

  test("evento antigo e legítimo que chega tarde não paga o desafio novo", async () => {
    const s = memoria();
    const velho = await conta(s, "u1", "d1");
    await limparRecompensa("d1", "u1", s);
    const novo = await prepararRecompensa({ userId: "u1", desafioId: "d2" }, s);
    assert.notEqual(velho.dynamicUserId, novo.dynamicUserId);
    const r = await callback(s, query(velho.lpUid, velho.dynamicUserId, { eventId: "evtVelho" }));
    assert.deepEqual([r.status, r.ack], [409, false]);
    assert.equal(await reciboDoDesafio("d2", s), null);
  });

  test("segundo evento distinto para o mesmo desafio: reconhecido, e o primeiro recibo permanece", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    await callback(s, query(lpUid, dynamicUserId));
    const r = await callback(s, query(lpUid, dynamicUserId, { eventId: "evt0002" }));
    assert.ok(r.ack);
    assert.equal((await reciboDoDesafio("d1", s))?.eventId, "evt0001");
  });

  test("ausência de desafio pendente (expirou): sem ACK e sem recibo", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    s.dados.delete("ads:lp:ativo:u1"); // o TTL do pendente venceu
    const r = await callback(s, query(lpUid, dynamicUserId));
    assert.deepEqual([r.status, r.ack], [409, false]);
    assert.equal(await reciboDoDesafio("d1", s), null);
  });

  test("timestamp fora da janela, IP fora da lista, receptor desligado, sem chave", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    const q = () => query(lpUid, dynamicUserId);
    assert.equal((await callback(s, query(lpUid, dynamicUserId, { timestamp: ts(AGORA - 30 * 3600_000) }))).status, 400);
    assert.equal((await callback(s, q(), { ip: "1.2.3.4" })).status, 403);
    assert.equal((await callback(s, q(), { env: { ...ENV, LEVELPLAY_S2S_RECEIVER_ENABLED: "false" } })).status, 404);
    assert.equal((await callback(s, q(), { env: { ...ENV, LEVELPLAY_S2S_PRIVATE_KEY: "curta" } })).status, 503);
    assert.ok((await callback(s, q(), { ip: "1.2.3.4", env: { ...ENV, LEVELPLAY_S2S_IP_ALLOWLIST_DESLIGADA: "true" } })).ack, "homologação pode desligar a lista");
  });

  test("falha do armazenamento: 503 sem ACK; o reenvio completa; queda no meio do processamento também", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    s.falhar.set = true;
    const r = await callback(s, query(lpUid, dynamicUserId));
    assert.deepEqual([r.status, r.ack], [503, false]);
    s.falhar.set = false;
    assert.ok((await callback(s, query(lpUid, dynamicUserId))).ack);
    assert.equal((await reciboDoDesafio("d1", s))?.eventId, "evt0001");

    const t = memoria();
    const c2 = await conta(t, "u2", "d2");
    t.dados.set("ads:lp:e:evt0001", "d2"); // reservou o evento e caiu antes do recibo
    assert.ok((await callback(t, query(c2.lpUid, c2.dynamicUserId))).ack);
    assert.ok(await reciboDoDesafio("d2", t), "o reenvio gravou o recibo que faltava");
  });

  test("tempo de resposta: poucos acessos ao armazenamento e dentro dos 400 ms com latência de rede simulada", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d1");
    s.latenciaMs.v = 40; // ordem de grandeza de um round trip a um Redis remoto
    s.operacoes.n = 0;
    const t0 = performance.now();
    const r = await callback(s, query(lpUid, dynamicUserId));
    const dt = performance.now() - t0;
    assert.ok(r.ack);
    assert.ok(s.operacoes.n <= 6, `acessos: ${s.operacoes.n}`);
    assert.ok(dt < 400, `levou ${dt.toFixed(0)} ms`);
  });
});

describe("preparar e estado", () => {
  const req = (corpo: unknown) =>
    new NextRequest("https://obaflix.test/api/ads/levelplay/preparar", {
      method: "POST", headers: { "content-type": "application/json", host: "obaflix.test" }, body: JSON.stringify(corpo),
    });
  const portas = (userId: string, s: ArmazemDeRecompensa, env: Record<string, string | undefined> = ENV) => ({
    getUserFromRequest: async () => ({ userId, role: "user", origem: "cookie" as const, deviceId: null }),
    checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
    isIpBlocked: async () => false,
    recordAbuseAttempt: async () => {},
    prepararRecompensa: (e: { userId: string; desafioId: string }) => prepararRecompensa(e, s),
    env,
  });
  const alvo = { tipo: "filme" as const, conteudoId: "f1", temporada: null, episodio: null };

  test("só para desafio da própria conta, de reprodução e Android; flags desligadas = 404 e nada travado", async () => {
    const s = memoria();
    const ok = await abrirDesafio({ userId: "u1", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    const download = await abrirDesafio({ userId: "u1", tipo: "filme", plataforma: "android", finalidade: "download", alvo });
    const eletron = await abrirDesafio({ userId: "u1", tipo: "filme", plataforma: "electron", finalidade: "reproducao", alvo });
    const h = prepararPost.createForTest(portas("u1", s));
    assert.equal((await h(req({ desafioId: ok }))).status, 200);
    assert.equal((await h(req({ desafioId: download }))).status, 403, "download fica como está");
    assert.equal((await h(req({ desafioId: eletron }))).status, 403);
    assert.equal((await h(req({ desafioId: "inexistente" }))).status, 403);
    assert.equal((await prepararPost.createForTest(portas("outra", s))(req({ desafioId: ok }))).status, 403, "desafio de outra conta");
    const off = prepararPost.createForTest(portas("u1", memoria(), { ...ENV, ANUNCIO_REWARDED_PLAYER_ATIVO: "false" }));
    assert.equal((await off(req({ desafioId: ok }))).status, 404);
    const semChave = prepararPost.createForTest(portas("u1", memoria(), { ...ENV, LEVELPLAY_S2S_PRIVATE_KEY: undefined }));
    assert.equal((await semChave(req({ desafioId: ok }))).status, 404);
    assert.ok(await espiarDesafio(ok, "u1"), "preparar não consome o desafio");
  });

  test("segundo desafio da mesma conta enquanto há um pendente: 409 e sem trava", async () => {
    const s = memoria();
    const a = await abrirDesafio({ userId: "u1", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    const b = await abrirDesafio({ userId: "u1", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    const h = prepararPost.createForTest(portas("u1", s));
    assert.equal((await h(req({ desafioId: a }))).status, 200);
    const r = await h(req({ desafioId: b }));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).codigo, "recompensa_em_andamento");
    assert.equal(await modoDoDesafio(b, s), null);
  });

  test("estado: só o dono do pendente vê; confirma depois do callback", async () => {
    const s = memoria();
    const { lpUid, dynamicUserId } = await conta(s, "u1", "d9");
    const h = (userId: string) =>
      estadoGet.createForTest({
        getUserFromRequest: async () => ({ userId, role: "user", origem: "cookie" as const, deviceId: null }),
        checkRateLimit: async () => ({ allowed: true, remaining: 1 }),
        estadoDaRecompensa: (e) => estadoDaRecompensa(e, s),
        env: ENV,
      });
    const get = () => new NextRequest("https://obaflix.test/api/ads/levelplay/estado?desafioId=d9");
    assert.deepEqual(await (await h("u1")(get())).json(), { preparado: true, confirmada: false });
    assert.deepEqual(await (await h("intruso")(get())).json(), { preparado: false, confirmada: false });
    const cb = callbackGet.createForTest({ processar: (e) => processarCallbackLevelPlay(e, s), agora: () => AGORA, env: ENV });
    const url = new URL("https://obaflix.test/api/ads/levelplay/callback");
    for (const [k, v] of query(lpUid, dynamicUserId)) url.searchParams.set(k, v);
    const resp = await cb(new NextRequest(url, { headers: { "x-forwarded-for": IP_OK } }));
    assert.equal(await resp.text(), "evt0001:OK");
    assert.deepEqual(await (await h("u1")(get())).json(), { preparado: true, confirmada: true });
  });
});

describe("/api/ads/complete com recibo S2S", () => {
  const alvo = { tipo: "filme" as const, conteudoId: "f_s2s", temporada: null, episodio: null };
  const corpo = (desafioId: string) =>
    new NextRequest("https://obaflix.test/api/ads/complete", {
      method: "POST", headers: { "content-type": "application/json", host: "obaflix.test" }, body: JSON.stringify({ desafioId, concluido: true }),
    });
  const complete = (userId: string, s: ArmazemDeRecompensa, ligado: boolean, agora = Date.now() + 10 * 60_000) =>
    completePost.createForTest({
      getUserFromRequest: async () => ({ userId, role: "user", origem: "cookie" as const, deviceId: null }),
      monetizacaoAtiva: () => false,
      promocaoTvAtiva: () => false,
      anuncioAndroidAtivo: () => true,
      anuncioElectronAtivo: () => false,
      checkRateLimit: async () => ({ allowed: true, remaining: 19 }),
      isIpBlocked: async () => false,
      recordAbuseAttempt: async () => {},
      agora: () => agora,
      recompensaPlayerAtiva: () => ligado,
      modoDoDesafio: (d) => modoDoDesafio(d, s),
      reciboDoDesafio: (d) => reciboDoDesafio(d, s),
      limparRecompensa: (d, u) => limparRecompensa(d, u, s),
    });

  test("sem recibo: 409 pendente e desafio vivo; com recibo: concessão uma vez, e a repetição não paga de novo", async () => {
    const s = memoria();
    const id = await abrirDesafio({ userId: "uc", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    const { lpUid, dynamicUserId } = await conta(s, "uc", id);
    const h = complete("uc", s, true);

    const antes = await h(corpo(id));
    assert.equal(antes.status, 409);
    assert.equal((await antes.json()).codigo, "recompensa_pendente");
    assert.ok(await espiarDesafio(id, "uc"), "o desafio continua vivo");

    assert.ok((await callback(s, query(lpUid, dynamicUserId))).ack);
    const depois = await h(corpo(id));
    assert.equal(depois.status, 200);
    assert.ok((await depois.json()).concessao);
    assert.equal(await espiarDesafio(id, "uc"), null, "consumido");
    assert.equal((await h(corpo(id))).status, 403, "segunda conclusão: sem desafio, sem concessão");
    assert.equal(await modoDoDesafio(id, s), null, "limpou a trava");
    assert.ok((await callback(s, query(lpUid, dynamicUserId))).ack, "reentrega tardia do mesmo evento: ACK, sem nova concessão");
    assert.equal((await h(corpo(id))).status, 403);
  });

  test("o callback local nunca libera: sem callback do servidor o desafio fica pendente e nada é concedido", async () => {
    const s = memoria();
    const id = await abrirDesafio({ userId: "uc", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    await conta(s, "uc", id);
    for (let i = 0; i < 3; i++) assert.equal((await complete("uc", s, true)(corpo(id))).status, 409);
    assert.ok(await espiarDesafio(id, "uc"));
  });

  test("recibo vale sem o tempo mínimo; recibo de outro desafio não vale; outra conta não usa o recibo", async () => {
    const s = memoria();
    const a = await abrirDesafio({ userId: "uc", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    const pa = await conta(s, "uc", a);
    const b = await abrirDesafio({ userId: "uc", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    await callback(s, query(pa.lpUid, pa.dynamicUserId));
    const agoraCedo = Date.now(); // desafio acabou de abrir: o tempo mínimo recusaria um Interstitial
    assert.equal((await complete("uc", s, true, agoraCedo)(corpo(b))).status, 403, "b não tem recibo nem está no modo Rewarded: vale o tempo mínimo");
    assert.equal((await complete("uc", s, true, agoraCedo)(corpo(a))).status, 200, "o recibo de a basta, sem tempo mínimo");
    // outra conta com o id de um desafio com recibo: recusada (e o desafio é queimado, como em todo uso indevido)
    const c = await abrirDesafio({ userId: "uc", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    await limparRecompensa(a, "uc", s);
    const pc = await conta(s, "uc", c);
    await callback(s, query(pc.lpUid, pc.dynamicUserId, { eventId: "evtC" }));
    assert.equal((await complete("intruso", s, true, agoraCedo)(corpo(c))).status, 403, "outra conta não usa o recibo");
  });

  test("flag desligada mantém o comportamento de sempre", async () => {
    const s = memoria();
    const livre = await abrirDesafio({ userId: "ud", tipo: "filme", plataforma: "android", finalidade: "reproducao", alvo });
    assert.equal((await complete("ud", s, false)(corpo(livre))).status, 200);
  });
});
