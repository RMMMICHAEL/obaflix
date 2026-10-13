import { test } from "node:test";
import assert from "node:assert/strict";
import { adsRemoteConfig } from "../ads/remoteConfig";
const hostile = JSON.stringify({ interstitial: true, rewarded: true, appOpen: true, banner: true,
  placements: ["home", "kids", "playback", "unknown"], sessionCap: 1000, intervalSeconds: -1 });
test("config maliciosa não supera regras Play, Kids, App Open ou limites", () => {
  const config = adsRemoteConfig(hostile, true, true);
  assert.equal(config.interstitial, false);
  assert.equal(config.appOpen, false);
  assert.deepEqual(config.placements, ["home", "playback"]);
  assert.equal(config.sessionCap, 4);
  assert.equal(config.intervalSeconds, 120);
});
test("sem anúncios, config ausente ou inválida: nenhum formato habilitado", () => {
  for (const config of [adsRemoteConfig(hostile, false, false), adsRemoteConfig(undefined, false, true), adsRemoteConfig("{", true, true)]) {
    assert.equal(config.rewarded || config.banner || config.interstitial || config.appOpen, false);
  }
  assert.equal(adsRemoteConfig(hostile, false, true).interstitial, true);
});
