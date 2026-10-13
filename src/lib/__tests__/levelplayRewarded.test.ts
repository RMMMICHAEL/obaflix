import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { LevelPlayRewards, autenticarCommission, rewardedConfigurado, type Commission } from "../ads/levelplayRewarded";
import { getRedis } from "../redis";

const secret = "test-only-private-key-not-a-real-credential";
const time = Date.UTC(2026, 9, 12, 12, 30, 0);
const alvo = { tipo: "filme" as const, conteudoId: "synthetic", temporada: null, episodio: null };
function signed(id: string, eventId = "event1", timestamp = "202610121230"): Commission {
  const input = { applicationUserId: id, eventId, timestamp, rewards: "1", signature: "" };
  input.signature = createHash("md5").update(timestamp + eventId + id + input.rewards + secret).digest("hex");
  return input;
}
test("segredo/flags ausentes mantêm novos grants desabilitados", () => {
  assert.equal(rewardedConfigurado({}), false);
  assert.equal(rewardedConfigurado({ LEVELPLAY_REWARDED_ENABLED: "true", LEVELPLAY_S2S_VALIDATED: "true" }), false);
});
test("callback falso, campos alterados e timestamp inválido são recusados", () => {
  const input = signed("a".repeat(48));
  assert.equal(autenticarCommission(input, secret, time), true);
  for (const patch of [{ signature: "0".repeat(32) }, { rewards: "2" }, { applicationUserId: "b".repeat(48) }, { timestamp: "202602301230" }, { timestamp: "202610121240" }]) {
    assert.equal(autenticarCommission({ ...input, ...patch }, secret, time), false);
  }
});
test("cliente/tempo não concedem; S2S duplicado e corridas geram uma concessão ao alvo exato", async () => {
  let grants = 0;
  let now = time;
  const rewards = new LevelPlayRewards(getRedis(), () => now, async input => {
    assert.equal(input.verificacao, "hard");
    assert.deepEqual(input.alvo, alvo);
    assert.equal(input.finalidade, "reproducao");
    grants++;
    return "synthetic-grant";
  });
  const id = await rewards.open({ userId: "synthetic-user", finalidade: "reproducao", alvo });
  now += 7000;
  assert.deepEqual(await rewards.status(id, "synthetic-user"), { state: "pending" });
  assert.deepEqual(await rewards.status(id, "other-user"), { state: "unavailable" });
  assert.equal(grants, 0);
  const input = signed(id, "race" + id);
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => rewards.callback(input, secret))), Array(5).fill("ok"));
  await Promise.all(Array.from({ length: 5 }, () => rewards.status(id, "synthetic-user")));
  assert.equal(grants, 1);
  assert.equal((await rewards.status(id, "synthetic-user")).concessao, "synthetic-grant");
  const other = await rewards.open({ userId: "synthetic-user", finalidade: "download", alvo });
  assert.equal(await rewards.callback(signed(other, input.eventId), secret), "invalid");
  assert.equal(await rewards.callback(signed(id, "different" + id), secret), "invalid");
});
test("S2S atrasado antes da expiração funciona; após expiração não concede", async () => {
  let now = time;
  const rewards = new LevelPlayRewards(getRedis(), () => now, async () => "delayed-grant");
  const id = await rewards.open({ userId: "delayed", finalidade: "reproducao", alvo });
  now += 9 * 60_000;
  assert.equal(await rewards.callback(signed(id, "delay" + id, "202610121239"), secret), "ok");
  assert.equal((await rewards.status(id, "delayed")).state, "verified");
  const expired = await rewards.open({ userId: "expired", finalidade: "reproducao", alvo });
  now += 11 * 60_000;
  assert.equal(await rewards.callback(signed(expired, "expiry" + expired, "202610121250"), secret), "expired");
  assert.equal((await rewards.status(expired, "expired")).state, "unavailable");
});

test("somente reprodução validada marca o alvo pago uma vez; outras finalidades não marcam", async () => {
  let marked = 0;
  const service = new LevelPlayRewards(getRedis(), () => time, async () => "synthetic", async input => {
    assert.equal(input.userId, "paid-marker-test");
    assert.equal(input.finalidade, "reproducao");
    assert.deepEqual(input.alvo, alvo);
    marked++;
  });
  for (const finalidade of ["reproducao", "download", "transmissao"] as const) {
    const id = await service.open({ userId: "paid-marker-test", finalidade, alvo });
    await service.status(id, "paid-marker-test");
    assert.equal(marked, finalidade === "reproducao" ? 0 : 1);
    assert.equal(await service.callback(signed(id, "marker" + id), secret), "ok");
    await service.status(id, "paid-marker-test");
    await service.status(id, "paid-marker-test");
    assert.equal(marked, 1);
  }
});
