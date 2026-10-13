import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/ads/admob/callback/route";
import { GoogleSsvKeys, verifySsv, unitsFromEnv, optionalChallengesEnabled, type AdmobUnits } from "../ads/admobSsv";
import { requestOptionalReward, optionalRewardStatus } from "../ads/admobOptionalClient";
import { readFileSync } from "node:fs";
import { optionalRequestScope } from "../ads/admobOptionalRequest";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const keys = { get: async () => pem };
const now = Date.UTC(2026, 9, 13, 12);
const nonce = "a".repeat(64);
// Synthetic identifiers only; never supplied to Android/GMA or dashboard.
const units: AdmobUnits = { play: "ca-app-pub-1111111111111111/1111111111", direct: "ca-app-pub-1111111111111111/2222222222", rewardAmount: "1", rewardItem: "synthetic_optional" };
function signed(patch: Record<string, string> = {}) {
  const fields = { ad_network: "5450213213286189855", ad_unit: "1111111111", custom_data: nonce,
    reward_amount: "1", reward_item: units.rewardItem, timestamp: String(now), transaction_id: "abc123", user_id: nonce, ...patch };
  const message = new URLSearchParams(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))).toString();
  return message + "&signature=" + sign("sha256", Buffer.from(message), pair.privateKey).toString("base64url") + "&key_id=1";
}
test("assinatura ECDSA válida; query alterada, reordenada e nonce trocado são recusados", async () => {
  assert.equal((await verifySsv(signed(), keys, units, now)).nonce, nonce);
  for (const query of [signed().replace("abc123", "abc124"), signed().replace(nonce, "b".repeat(64)),
    signed().replace("ad_network=5450213213286189855&ad_unit=1111111111", "ad_unit=1111111111&ad_network=5450213213286189855"),
    signed() + "&user_id=other"]) await assert.rejects(verifySsv(query, keys, units, now));
});
test("ad-unit, recompensa, user opaco e timestamp são validados além da assinatura", async () => {
  const invalid: Record<string, string>[] = [{ ad_unit: "9999999999" }, { reward_amount: "2" }, { reward_item: "other" },
    { user_id: "other-account" }, { timestamp: String(now + 120000) }, { timestamp: String(now - 25 * 3600000) }];
  for (const patch of invalid) {
    await assert.rejects(verifySsv(signed(patch), keys, units, now));
  }
});
test("flags e IDs ausentes não permitem desafios ou grants; unidades não podem ser iguais", () => {
  assert.equal(optionalChallengesEnabled(), false);
  assert.equal(unitsFromEnv({}), null);
  assert.equal(unitsFromEnv({ ADMOB_REWARDED_PLAY_STANDARD_ID: units.play, ADMOB_REWARDED_DIRECT_STANDARD_ID: units.play, ADMOB_REWARD_AMOUNT: "1", ADMOB_REWARD_ITEM: units.rewardItem }), null);
});
test("rotação de chaves: cache limitado, chave desconhecida e falha de origem falham fechadas", async () => {
  let time = now;
  let calls = 0;
  let fail = false;
  const cache = new GoogleSsvKeys(async (url, init) => {
    assert.equal(String(url), "https://www.gstatic.com/admob/reward/verifier-keys.json");
    assert.equal(init?.redirect, "error");
    calls++;
    if (fail) throw new Error("synthetic outage");
    return new Response(JSON.stringify({ keys: [{ keyId: calls, pem }] }));
  }, () => time);
  await Promise.all([cache.get("1"), cache.get("1")]);
  assert.equal(calls, 1);
  await assert.rejects(cache.get("99"));
  time += 60001;
  assert.equal(await cache.get("2"), pem);
  time += 24 * 3600000; fail = true;
  await assert.rejects(cache.get("2"));
});
test("ACK apenas após commit; assinatura falsa e falha de banco não recebem 200", async () => {
  let committed = false;
  const handler = GET.createForTest({ enabled: () => true, units: () => units, keys,
    now: () => now, receive: async () => { committed = true; return "verified"; } });
  const response = await handler(new NextRequest("https://synthetic.invalid/api/ads/admob/callback?" + signed()));
  assert.equal(response.status, 200); assert.equal(committed, true);
  const bad = await handler(new NextRequest("https://synthetic.invalid/api/ads/admob/callback?" + signed().replace("abc123", "abc124")));
  assert.equal(bad.status, 403);
  const broken = GET.createForTest({ enabled: () => true, units: () => units, keys, now: () => now,
    receive: async () => { throw new Error("rollback"); } });
  assert.equal((await broken(new NextRequest("https://synthetic.invalid/?" + signed()))).status, 503);
});
test("entitlement sem anúncios não autoriza nem cria operação; origem e distribuição inválidas são recusadas", async () => {
  let limits = 0;
  const deps = {
    user: async () => ({ userId: "synthetic-paid", role: "user", origem: "cookie" as const, deviceId: null }),
    eligible: async () => false,
    limit: async () => { limits++; return { allowed: true, remaining: 1 }; },
  };
  const req = new NextRequest("https://synthetic.invalid/api/ads/admob/challenge", { headers: { host: "synthetic.invalid", origin: "https://synthetic.invalid", "x-obaflix-distribution": "play" } });
  assert.equal(await optionalRequestScope(req, deps), null);
  assert.equal(limits, 0);
  assert.equal(await optionalRequestScope(new NextRequest(req.url), { ...deps, eligible: async () => true }), null);
});
test("timestamp de 16 dígitos do exemplo oficial é normalizado sem alterar dados assinados", async () => {
  assert.equal((await verifySsv(signed({ timestamp: String(now * 1000) }), keys, units, now)).timestamp, now);
});
test("evento cliente apenas consulta SSV; callback de outro nonce não consulta nem concede", async () => {
  const events = new EventTarget();
  let polls = 0;
  const statuses: Array<{ state: string; benefitGranted: boolean }> = [];
  const request: typeof fetch = async url => {
    if (String(url).endsWith("/status")) { polls++; return new Response(JSON.stringify({ state: "verified", benefitGranted: true })); }
    return new Response(JSON.stringify({ nonce, protocol: "admob-ssv-v1" }));
  };
  const result = await requestOptionalReward({ tipo: "filme", conteudoId: "synthetic", distribution: "direct", optIn: true,
    bridge: { capability: "test", optionalRewardedProtocol: "admob-ssv-v1", mostrarRewardedOpcional: () => {} }, request, events, onStatus: value => statuses.push(value) });
  events.dispatchEvent(new CustomEvent("obaflixoptionalreward", { detail: { nonce: "b".repeat(64), event: "client_reward_signal" } }));
  assert.equal(polls, 0);
  events.dispatchEvent(new CustomEvent("obaflixoptionalreward", { detail: { nonce, event: "client_reward_signal" } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(polls, 1);
  assert.deepEqual(statuses, [{ state: "verified", benefitGranted: false }]);
  result.dispose?.();
});
test("opt-in obrigatório e callback/estado cliente não oferecem benefício ou playback", async () => {
  let shows = 0; let requests = 0;
  const bridge = { capability: "synthetic", optionalRewardedProtocol: "admob-ssv-v1", mostrarRewardedOpcional: () => { shows++; } };
  const request: typeof fetch = async url => { requests++; assert.equal(String(url).includes("playback"), false); return new Response(JSON.stringify({ nonce, protocol: "admob-ssv-v1", state: "verified", benefitGranted: true })); };
  const input = { tipo: "filme" as const, conteudoId: "synthetic", distribution: "play" as const, bridge, request, optIn: false };
  await requestOptionalReward(input); assert.equal(requests, 0);
  const result = await requestOptionalReward({ ...input, optIn: true });
  assert.equal(shows, 1); assert.equal(result.benefitGranted, false);
  assert.equal((await optionalRewardStatus(nonce, "play", request)).benefitGranted, false);
});
test("coexistência: SDK único, init pós CMP/entitlement, novas unidades e gates fixos", () => {
  const build = readFileSync("android/app/build.gradle", "utf8");
  assert.match(build, /'ADMOB_REWARDED_APPROVED', 'false'/);
  for (const id of ["ADMOB_REWARDED_PLAY_STANDARD_ID", "ADMOB_REWARDED_DIRECT_STANDARD_ID"]) assert.ok(build.includes(id));
  const init = readFileSync("android/app/src/main/java/com/obaflix/ads/GoogleAdsInitialization.java", "utf8");
  assert.equal(init.includes("disableMediationAdapterInitialization()"), false);
  assert.ok(init.indexOf("!eligible || !consent") < init.indexOf("MobileAds.initialize"));
  const bridge = readFileSync("android/app/src/main/java/com/obaflix/ads/AdsBridge.kt", "utf8");
  const optional = bridge.slice(bridge.indexOf("fun mostrarRewardedOpcional"), bridge.indexOf("fun mostrarBanner"));
  assert.ok(optional.indexOf("AdmobChallengeEligibility.check") < optional.indexOf("AdConsent.request"));
  assert.equal(optional.includes("__obaflixAnuncioConcluido"), false);
  const lock = readFileSync("android/app/gradle.lockfile", "utf8");
  assert.match(lock, /ads-mobile-sdk:1\.5\.0/); assert.equal(lock.includes("play-services-ads:"), false);
  const store = readFileSync("src/lib/ads/admobStore.ts", "utf8");
  assert.ok(store.includes("isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted"));
});
