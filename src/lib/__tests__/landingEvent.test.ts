import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { validateLandingEvent } from "../marketing/landing-event";
import { handleLandingEvent, sameOriginRejection } from "../marketing/landing-event-ingest";

const ENDPOINT = "https://obaflixbr.com/api/marketing/landing-event";

function post(body: string, headers: Record<string, string> = {}): NextRequest {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "content-length": String(body.length), ...headers },
    body,
  }) as unknown as NextRequest;
}

test("validateLandingEvent aceita os três eventos no contexto certo", () => {
  const view = validateLandingEvent({ event: "landing_view", context: "in_app", placement: "page" });
  assert.equal(view.ok, true);
  assert.deepEqual(view.ok && view.value, { event: "landing_view", context: "in_app", placement: "page", source: "none", medium: "none", campaign: "none", content: "none" });

  assert.equal(validateLandingEvent({ event: "landing_view", context: "browser", placement: "page" }).ok, true);
  assert.equal(validateLandingEvent({ event: "open_external_browser_click", context: "in_app", placement: "hero" }).ok, true);
  assert.equal(validateLandingEvent({ event: "android_download_click", context: "browser", placement: "bar" }).ok, true);
});

test("validateLandingEvent sanitiza UTM e recusa fora do enum/funil", () => {
  const ok = validateLandingEvent({
    event: "android_download_click", context: "browser", placement: "final",
    attribution: { source: "TikTok", medium: "promote", campaign: "android_outubro", content: "video01", evil: "x" },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value.source, "tiktok");
  assert.equal(ok.ok && (ok.value as Record<string, unknown>).evil, undefined);

  for (const bad of [
    null, 42, "x", [], { event: "install", context: "browser", placement: "hero" },
    { event: "landing_view", context: "nope", placement: "page" },
    { event: "landing_view", context: "in_app", placement: "sidebar" },
    { event: "landing_view", context: "in_app", placement: "hero" }, // view exige page
    { event: "open_external_browser_click", context: "browser", placement: "hero" }, // exige in_app
    { event: "android_download_click", context: "in_app", placement: "hero" }, // exige browser
    { event: "open_external_browser_click", context: "in_app", placement: "page" }, // clique não é page
  ]) {
    const r = validateLandingEvent(bad as unknown);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(!r.ok && r.status, 400);
  }
});

test("same-origin: recusa cross-site, aceita same-origin/none", () => {
  assert.equal(sameOriginRejection(post("{}", { "sec-fetch-site": "cross-site" }))?.status, 403);
  assert.equal(sameOriginRejection(post("{}", { "sec-fetch-site": "same-origin" })), null);
  assert.equal(sameOriginRejection(post("{}", { "sec-fetch-site": "none" })), null);
  // Origin divergente do Host também é recusado.
  const cross = new Request(ENDPOINT, { method: "POST", headers: { origin: "https://evil.example", host: "obaflixbr.com" } }) as unknown as NextRequest;
  assert.equal(sameOriginRejection(cross)?.status, 403);
});

test("POST válido responde 204 e incrementa com dados normalizados", async () => {
  const calls: unknown[] = [];
  const body = JSON.stringify({ event: "android_download_click", context: "browser", placement: "hero", attribution: { source: "TikTok", medium: "promote" } });
  const res = await handleLandingEvent(post(body), { increment: async (v) => { calls.push(v); } });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.deepEqual(calls, [{ event: "android_download_click", context: "browser", placement: "hero", source: "tiktok", medium: "promote", campaign: "none", content: "none" }]);
});

test("POST inválido 400 e não incrementa; método errado 405", async () => {
  let chamou = false;
  const inc = async () => { chamou = true; };
  assert.equal((await handleLandingEvent(post(JSON.stringify({ event: "install", context: "browser", placement: "hero" })), { increment: inc })).status, 400);
  assert.equal((await handleLandingEvent(post("{isto nao e json"), { increment: inc })).status, 400);
  assert.equal(chamou, false);

  const get = new Request(ENDPOINT, { method: "GET" }) as unknown as NextRequest;
  assert.equal((await handleLandingEvent(get, { increment: inc })).status, 405);
});

test("corpo gigante é recusado (413), por content-length e por tamanho real", async () => {
  const grande = JSON.stringify({ event: "landing_view", context: "in_app", placement: "page", attribution: { source: "a".repeat(4000) } });
  // content-length honesto > 2KB
  assert.equal((await handleLandingEvent(post(grande), { increment: async () => {} })).status, 413);
  // content-length mentido pequeno, corpo real grande → a segunda guarda pega
  assert.equal((await handleLandingEvent(post(grande, { "content-length": "10" }), { increment: async () => {} })).status, 413);
});

test("fail open: se o incremento falhar, ainda responde 204", async () => {
  const body = JSON.stringify({ event: "landing_view", context: "in_app", placement: "page" });
  const res = await handleLandingEvent(post(body), { increment: async () => { throw new Error("db down"); } });
  assert.equal(res.status, 204);
});
