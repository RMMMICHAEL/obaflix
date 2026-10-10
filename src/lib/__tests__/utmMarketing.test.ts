import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeUtmValue, sanitizeUtm, parseUtm,
  buildLandingExternalUrl, buildLandingIntentUrl, UTM_NONE,
} from "../marketing/utm";

test("UTM válidos passam; inválidos viram none", () => {
  assert.equal(sanitizeUtmValue("tiktok"), "tiktok");
  assert.equal(sanitizeUtmValue("promote"), "promote");
  assert.equal(sanitizeUtmValue("android_outubro"), "android_outubro");
  assert.equal(sanitizeUtmValue("video01"), "video01");
  // uppercase normaliza; trim normaliza.
  assert.equal(sanitizeUtmValue("TikTok"), "tiktok");
  assert.equal(sanitizeUtmValue("  Promote  "), "promote");
  // recusados → "none"
  for (const bad of [
    "two words", "a b", "https://evil.example", "http://x", "a@b.com",
    "<script>", "a;end", "intent://x", "a/b", "a?b", "a#b", "a=b", "a%20b",
    "a".repeat(65), "", "   ", "acentuação", "ção", "\n\t",
    123 as unknown as string, null as unknown as string, undefined as unknown as string, {} as unknown as string,
  ]) {
    assert.equal(sanitizeUtmValue(bad), UTM_NONE, JSON.stringify(bad));
  }
  // exatamente 64 é aceito.
  assert.equal(sanitizeUtmValue("a".repeat(64)), "a".repeat(64));
});

test("parseUtm lê apenas os quatro utm_* e ignora o resto", () => {
  const utm = parseUtm("utm_source=TikTok&utm_medium=promote&utm_campaign=android_outubro&utm_content=video01&evil=https://x&ttclid=abc&gclid=1");
  assert.deepEqual(utm, { source: "tiktok", medium: "promote", campaign: "android_outubro", content: "video01" });
  // parâmetros desconhecidos e click-ids simplesmente não existem no objeto.
  assert.equal(Object.keys(utm).length, 4);
});

test("sanitizeUtm fecha o objeto e preenche none", () => {
  assert.deepEqual(sanitizeUtm({ source: "tiktok" }), { source: "tiktok", medium: UTM_NONE, campaign: UTM_NONE, content: UTM_NONE });
  assert.deepEqual(sanitizeUtm(undefined), { source: UTM_NONE, medium: UTM_NONE, campaign: UTM_NONE, content: UTM_NONE });
});

test("handoff: URL externa preserva os quatro UTMs, base e scheme fixos", () => {
  const utm = parseUtm("utm_source=tiktok&utm_medium=promote&utm_campaign=android_outubro&utm_content=video01");
  const url = buildLandingExternalUrl(utm);
  assert.equal(url, "https://obaflixbr.com/baixar?utm_source=tiktok&utm_medium=promote&utm_campaign=android_outubro&utm_content=video01");
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.host, "obaflixbr.com");
  assert.equal(parsed.pathname, "/baixar");
});

test("handoff: parâmetros desconhecidos/hostis são removidos", () => {
  const utm = parseUtm("utm_source=tiktok&evil=https://site-malicioso.com&next=//evil");
  assert.equal(buildLandingExternalUrl(utm), "https://obaflixbr.com/baixar?utm_source=tiktok");
  // Sem UTM válido → URL base limpa, nunca outro host.
  assert.equal(buildLandingExternalUrl(parseUtm("evil=1&foo=bar")), "https://obaflixbr.com/baixar");
});

test("handoff: Intent URI fixo, nenhuma query controla o intent", () => {
  const intent = buildLandingIntentUrl(parseUtm("utm_source=tiktok&utm_medium=promote"));
  assert.equal(intent, "intent://obaflixbr.com/baixar?utm_source=tiktok&utm_medium=promote#Intent;scheme=https;action=android.intent.action.VIEW;end");
  // Tentativa de injeção no valor é neutralizada na sanitização (vira none).
  const hostil = buildLandingIntentUrl(parseUtm("utm_source=a%3Bpackage%3Dcom.evil&utm_campaign=x%23Intent"));
  assert.equal(hostil, "intent://obaflixbr.com/baixar#Intent;scheme=https;action=android.intent.action.VIEW;end");
  assert.ok(hostil.startsWith("intent://obaflixbr.com/baixar"));
  assert.ok(hostil.endsWith("scheme=https;action=android.intent.action.VIEW;end"));
});
