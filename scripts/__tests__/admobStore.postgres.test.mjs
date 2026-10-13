import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "../../android/app/build/ads-test-db/node_modules/@electric-sql/pglite/dist/index.js";
import { AdmobRewards } from "../../src/lib/ads/admobStore.ts";

// Isolated PostgreSQL WASM engine, no network/connection strings/production data.
const db = new PGlite();
await db.exec(readFileSync(new URL("../../docs/sql/admob-rewarded-inbox.sql", import.meta.url), "utf8"));
let failWrite = false;
function adapter(tx) {
  return {
    query: async sql => (await tx.query(sql.text, sql.values)).rows,
    execute: async sql => {
      if (failWrite && sql.text.includes("UPDATE ads_private.admob_challenge SET state='verified'")) throw new Error("synthetic database failure");
      return (await tx.query(sql.text, sql.values)).affectedRows ?? 0;
    },
  };
}
const store = { ...adapter(db), transaction: work => db.transaction(tx => work(adapter(tx))) };
const start = Date.UTC(2026, 9, 13, 12);
let time = start;
const service = new AdmobRewards(store, () => time);
const units = { play: "ca-app-pub-1111111111111111/1111111111", direct: "ca-app-pub-1111111111111111/2222222222", rewardAmount: "1", rewardItem: "synthetic_optional" };
const target = { tipo: "filme", conteudoId: "synthetic-film" };
const scope = (id, distribution = "play", content = target) => ({ accountId: id, distribution, target: content });
const event = (nonce, transactionId, patch = {}) => ({ nonce, userId: nonce, transactionId, unit: "1111111111", timestamp: start + 60000, amount: "1", item: units.rewardItem, digest: "synthetic-digest-" + transactionId, ...patch });
after(async () => { await db.close(); });

test("schema privado sem exposição pública e finalidade de playback proibida", async () => {
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated;");
  await assert.rejects(db.exec("SET ROLE anon; SELECT * FROM ads_private.admob_ssv_inbox;"));
  await db.exec("RESET ROLE;");
  const result = await db.query("SELECT relrowsecurity FROM pg_class WHERE relname='admob_ssv_inbox'");
  assert.equal(result.rows[0].relrowsecurity, true);
});
test("nonce único, uma operação ativa e scope de conta/distribuição preservado", async () => {
  const results = await Promise.allSettled([service.openAuthorized(scope("parallel"), units), service.openAuthorized(scope("parallel"), units)]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const first = results.find(value => value.status === "fulfilled").value;
  assert.match(first.nonce, /^[a-f0-9]{64}$/);
  assert.equal((await service.status(first.nonce, "other", "play", units)).state, "unavailable");
  assert.equal((await service.status(first.nonce, "parallel", "direct", units)).state, "unavailable");
});
test("callbacks concorrentes/duplicados persistem uma única transação sem benefício", async () => {
  const challenge = await service.openAuthorized(scope("duplicates"), units);
  const input = event(challenge.nonce, "abc001");
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => service.receive(input)));
  assert.equal(outcomes.filter(value => value === "verified").length, 1);
  assert.equal(outcomes.filter(value => value === "duplicate").length, 7);
  const status = await service.status(challenge.nonce, "duplicates", "play", units);
  assert.equal(status.state, "verified"); assert.equal(status.benefitGranted, false);
  const rows = await db.query("SELECT * FROM ads_private.admob_ssv_inbox WHERE transaction_id='abc001'");
  assert.equal(rows.rows.length, 1);
});
test("evento de outra distribuição e replay para outro conteúdo/finalidade não validam", async () => {
  const direct = await service.openAuthorized(scope("distribution", "direct"), units);
  assert.equal(await service.receive(event(direct.nonce, "abc002")), "rejected");
  assert.equal((await service.status(direct.nonce, "distribution", "direct", units)).state, "pending");
  const another = await service.openAuthorized(scope("another", "play", { ...target, conteudoId: "other-film" }), units);
  await assert.rejects(service.receive(event(another.nonce, "abc001")), /transaction conflict/);
  assert.equal((await service.status(another.nonce, "another", "play", units)).state, "pending");
  await assert.rejects(db.query("UPDATE ads_private.admob_challenge SET purpose='reproducao' WHERE nonce=$1", [another.nonce]));
});
test("callback atrasado usa timestamp assinado; anúncio completado após expiração é rejeitado", async () => {
  time = start;
  const delayed = await service.openAuthorized(scope("delayed"), units);
  const expired = await service.openAuthorized(scope("expired"), units);
  time += 20 * 60000;
  assert.equal(await service.receive(event(delayed.nonce, "abc003", { timestamp: start + 9 * 60000 })), "verified");
  assert.equal(await service.receive(event(expired.nonce, "abc004", { timestamp: start + 11 * 60000 })), "rejected");
  assert.equal((await service.status(expired.nonce, "expired", "play", units)).state, "expired");
});
test("rollback após INSERT não deixa ACK/prova parcial; retry pode persistir uma vez", async () => {
  time = start;
  const challenge = await service.openAuthorized(scope("rollback"), units);
  const input = event(challenge.nonce, "abc005");
  failWrite = true;
  await assert.rejects(service.receive(input));
  failWrite = false;
  assert.equal((await db.query("SELECT * FROM ads_private.admob_ssv_inbox WHERE transaction_id='abc005'")).rows.length, 0);
  assert.equal((await service.status(challenge.nonce, "rollback", "play", units)).state, "pending");
  assert.equal(await service.receive(input), "verified");
  assert.equal(await service.receive(input), "duplicate");
});
test("cancelamento compete com verificação no mesmo lock de linha; nunca há grant", async () => {
  const challenge = await service.openAuthorized(scope("cancel-race"), units);
  const [cancelled] = await Promise.all([service.status(challenge.nonce, "cancel-race", "play", units, true), service.receive(event(challenge.nonce, "abc006"))]);
  const final = await service.status(challenge.nonce, "cancel-race", "play", units);
  if (cancelled.state === "cancelled") assert.equal(final.state, "cancelled");
  assert.equal(final.benefitGranted, false);
});
test("Direct válido usa unidade própria; dois desafios sequenciais não compartilham recibo", async () => {
  time = start;
  const first = await service.openAuthorized(scope("direct-valid", "direct", { ...target, conteudoId: "first" }), units);
  const proof = event(first.nonce, "abc007", { unit: "2222222222" });
  assert.equal(await service.receive(proof), "verified");
  assert.equal((await service.status(first.nonce, "direct-valid", "direct", units)).state, "verified");
  const next = await service.openAuthorized(scope("direct-valid", "direct", { ...target, conteudoId: "second" }), units);
  assert.notEqual(next.nonce, first.nonce);
  assert.equal(await service.receive(proof), "duplicate");
  assert.equal((await service.status(next.nonce, "direct-valid", "direct", units)).state, "pending");
  assert.equal((await service.status(next.nonce, "direct-valid", "play", units)).state, "unavailable");
  const row = await db.query("SELECT target, purpose FROM ads_private.admob_challenge WHERE nonce=$1", [next.nonce]);
  assert.equal(row.rows[0].target.conteudoId, "second");
  assert.equal(row.rows[0].purpose, "optional_pending_policy");
});
