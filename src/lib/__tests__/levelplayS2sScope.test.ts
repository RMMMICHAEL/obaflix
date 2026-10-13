import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LevelPlayRewards, rewardedConfigurado } from "../ads/levelplayRewarded";
import { getRedis } from "../redis";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/ads/levelplay/callback/route";

const secret = "synthetic-test-key-only-never-a-dashboard-secret";
const start = Date.UTC(2026, 9, 12, 12, 30);
const target = { tipo: "filme" as const, conteudoId: "scope-movie", temporada: null, episodio: null };
function receipt(id: string, eventId = "scope" + id, now = start) {
  const timestamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return { applicationUserId: id, eventId, rewards: "1", timestamp,
    signature: createHash("md5").update(timestamp + eventId + id + "1" + secret).digest("hex") };
}
test("env não pode homologar campos que o protocolo não assina", () => {
  assert.equal(rewardedConfigurado({ LEVELPLAY_REWARDED_ENABLED: "true", LEVELPLAY_S2S_VALIDATED: "true", LEVELPLAY_S2S_PRIVATE_KEY: secret }), false);
});
test("uma conta não abre duas operações simultâneas no mesmo escopo", async () => {
  const service = new LevelPlayRewards(getRedis(), () => start, async () => "unused");
  const outcomes = await Promise.allSettled([1, 2].map(() => service.open({ userId: "scope-parallel", finalidade: "reproducao", alvo: target })));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
});
test("distribuição diferente não recebe a concessão", async () => {
  let grants = 0;
  const service = new LevelPlayRewards(getRedis(), () => start, async () => { grants++; return "scope-grant"; });
  const id = await service.open({ userId: "scope-distribution", finalidade: "reproducao", alvo: target });
  await service.callback(receipt(id), secret);
  assert.equal((await service.status(id, "scope-distribution", "direct")).state, "unavailable");
  assert.equal(grants, 0);
});
test("cancelamento impede callback legítimo de conceder", async () => {
  let grants = 0;
  const service = new LevelPlayRewards(getRedis(), () => start, async () => { grants++; return "unused"; });
  const id = await service.open({ userId: "scope-cancelled", finalidade: "reproducao", alvo: target });
  assert.equal(await service.cancel(id, "scope-cancelled"), true);
  assert.equal(await service.callback(receipt(id), secret), "invalid");
  assert.equal((await service.status(id, "scope-cancelled")).state, "unavailable");
  assert.equal(grants, 0);
});

test("assinatura legítima antiga não migra para outra conta, conteúdo ou finalidade", async () => {
  const emitted: unknown[] = [];
  const service = new LevelPlayRewards(getRedis(), () => start, async input => { emitted.push(input); return "grant-sequential-" + emitted.length; }, async () => {});
  const first = await service.open({ userId: "scope-sequential", finalidade: "reproducao", alvo: target });
  const old = receipt(first);
  await service.callback(old, secret);
  await service.status(first, "scope-sequential");
  const next = await service.open({ userId: "scope-sequential", finalidade: "download", alvo: { ...target, conteudoId: "other-content" } });
  const other = await service.open({ userId: "scope-other-account", finalidade: "transmissao", alvo: target });
  assert.equal(await service.callback(old, secret), "ok"); // ACK receipt only, never rebound.
  assert.equal(await service.callback({ ...old, applicationUserId: next }, secret), "invalid");
  assert.equal(await service.callback({ ...old, applicationUserId: other }, secret), "invalid");
  assert.equal((await service.status(next, "scope-sequential")).state, "pending");
  assert.equal((await service.status(other, "scope-other-account")).state, "pending");
  assert.equal((await service.status(first, "scope-other-account")).state, "unavailable");
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], { userId: "scope-sequential", finalidade: "reproducao", alvo: target, verificacao: "hard" });
});

test("corrida cancelamento/consumo tem um único vencedor atômico", async () => {
  for (let run = 0; run < 12; run++) {
    let grants = 0;
    const userId = "scope-cancel-race-" + run;
    const service = new LevelPlayRewards(getRedis(), () => start, async () => { grants++; return "race-grant"; }, async () => {});
    const id = await service.open({ userId, finalidade: "reproducao", alvo: target });
    await service.callback(receipt(id), secret);
    const [cancelled] = await Promise.all([service.cancel(id, userId), service.status(id, userId), service.status(id, userId)]);
    assert.ok(grants <= 1);
    if (cancelled) { assert.equal(grants, 0); assert.equal((await service.status(id, userId)).state, "unavailable"); }
    else assert.equal(grants, 1);
  }
});

test("falha parcial de persistência não concede; retry completa apenas a mesma identidade", async () => {
  const base = getRedis();
  let fail = true;
  let grants = 0;
  const store = new Proxy(base, { get(object, key) {
    if (key === "set") return async (...args: Parameters<typeof base.set>) => {
      if (args[0].includes(":proof:") && fail) throw new Error("synthetic storage unavailable");
      return object.set(...args);
    };
    const value = Reflect.get(object, key);
    return typeof value === "function" ? value.bind(object) : value;
  } });
  const service = new LevelPlayRewards(store, () => start, async () => { grants++; return "storage-grant"; }, async () => {});
  const id = await service.open({ userId: "scope-storage", finalidade: "reproducao", alvo: target });
  await assert.rejects(service.callback(receipt(id), secret));
  assert.equal((await service.status(id, "scope-storage")).state, "pending");
  assert.equal(grants, 0);
  fail = false;
  assert.equal(await service.callback(receipt(id), secret), "ok");
  await service.status(id, "scope-storage");
  assert.equal(grants, 1);
});

test("retorno do app recupera o mesmo resultado; callback tardio não paga outro desafio", async () => {
  let now = start;
  const base = getRedis();
  let grants = 0;
  const emit = async () => { grants++; return "resume-grant"; };
  const initial = new LevelPlayRewards(base, () => now, emit, async () => {});
  const id = await initial.open({ userId: "scope-resume", finalidade: "reproducao", alvo: target });
  now += 9 * 60_000;
  await initial.callback(receipt(id, "resume" + id, now), secret);
  await initial.status(id, "scope-resume");
  const resumed = new LevelPlayRewards(base, () => now, emit, async () => {});
  assert.equal((await resumed.status(id, "scope-resume")).concessao, "resume-grant");
  assert.equal(grants, 1);
  const next = await resumed.open({ userId: "scope-resume", finalidade: "reproducao", alvo: target });
  now += 11 * 60_000;
  assert.equal(await resumed.callback(receipt(next, "expired" + next, now), secret), "expired");
  assert.equal((await resumed.status(next, "scope-resume")).state, "unavailable");
  assert.equal(grants, 1);
});

test("ACK oficial somente após persistir; erros, parâmetros duplicados e HTTP não confirmam", async () => {
  const service = new LevelPlayRewards(getRedis(), () => start, async () => "unused");
  const id = await service.open({ userId: "scope-http", finalidade: "reproducao", alvo: target });
  const handler = GET.createForTest({ enabled: () => true, secret: () => secret, process: (input, key) => service.callback(input, key) });
  const query = new URLSearchParams(receipt(id));
  const url = "https://synthetic.invalid/api/ads/levelplay/callback?" + query;
  const response = await handler(new NextRequest(url));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), receipt(id).eventId + ":OK");
  assert.equal((await handler(new NextRequest(url))).status, 200);
  assert.equal((await handler(new NextRequest(url + "&eventId=other"))).status, 400);
  assert.equal((await handler(new NextRequest(url.replace("https:", "http:")))).status, 400);
  const broken = GET.createForTest({ enabled: () => true, secret: () => secret, process: async () => { throw new Error("storage unavailable"); } });
  const failure = await broken(new NextRequest(url));
  assert.equal(failure.status, 503);
  assert.equal((await failure.text()).includes(":OK"), false);
});

test("grants reais permanecem bloqueados e armazenamento não usa fallback implícito", async () => {
  assert.throws(() => new LevelPlayRewards(), /Persistent rewarded storage required/);
  const real = new LevelPlayRewards(getRedis(), () => start);
  assert.equal((await real.status("a".repeat(48), "synthetic")).state, "unavailable");
});

test("falha após emissão reserva consumo; retry nunca emite novamente", async () => {
  const base = getRedis();
  let fail = true;
  let grants = 0;
  const store = new Proxy(base, { get(object, key) {
    if (key === "set") return async (...args: Parameters<typeof base.set>) => {
      if (args[0].includes(":grant:") && fail) throw new Error("synthetic result write failure");
      return object.set(...args);
    };
    const value = Reflect.get(object, key);
    return typeof value === "function" ? value.bind(object) : value;
  } });
  const service = new LevelPlayRewards(store, () => start, async () => { grants++; return "unreturned-grant"; }, async () => {});
  const id = await service.open({ userId: "scope-result-failure", finalidade: "reproducao", alvo: target });
  await service.callback(receipt(id), secret);
  await assert.rejects(service.status(id, "scope-result-failure"));
  fail = false;
  assert.equal((await service.status(id, "scope-result-failure")).state, "pending");
  assert.equal(grants, 1);
});

test("cancelamento antigo não solta reserva de um novo desafio", async () => {
  const service = new LevelPlayRewards(getRedis(), () => start, async () => "unused");
  const userId = "scope-cancel-aba";
  const old = await service.open({ userId, finalidade: "reproducao", alvo: target });
  await service.cancel(old, userId);
  const next = await service.open({ userId, finalidade: "download", alvo: { ...target, conteudoId: "second" } });
  await service.cancel(old, userId);
  await assert.rejects(service.open({ userId, finalidade: "transmissao", alvo: target }), /already active/);
  assert.equal((await service.status(next, userId)).state, "pending");
});

test("callback assinado não aceita identidade/formato inexistente; campos extra não liberam grants reais", async () => {
  const real = new LevelPlayRewards(getRedis(), () => start);
  const id = await real.open({ userId: "scope-quarantine", finalidade: "reproducao", alvo: target });
  const input = { ...receipt(id), format: "interstitial", dynamicUserId: "unsigned", placement: "rewarded", distribution: "play" };
  assert.equal(await real.callback(input, secret), "ok"); // A quarantined receipt, not a rewarded grant.
  assert.equal((await real.status(id, "scope-quarantine")).state, "unavailable");
  assert.equal(await real.callback(receipt("b".repeat(48)), secret), "expired");
});

test("perda da reserva de operação falha fechada mesmo com assinatura válida", async () => {
  const base = getRedis();
  let grants = 0;
  const store = new Proxy(base, { get(object, key) {
    if (key === "get") return async (name: string) => name.includes(":active:") ? null : object.get(name);
    const value = Reflect.get(object, key);
    return typeof value === "function" ? value.bind(object) : value;
  } });
  const service = new LevelPlayRewards(store, () => start, async () => { grants++; return "unused"; });
  const id = await service.open({ userId: "scope-lost-reservation", finalidade: "reproducao", alvo: target });
  assert.equal(await service.callback(receipt(id), secret), "invalid");
  assert.equal((await service.status(id, "scope-lost-reservation")).state, "unavailable");
  assert.equal(grants, 0);
});
