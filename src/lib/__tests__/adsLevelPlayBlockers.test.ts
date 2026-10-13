import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POST } from "@/app/api/ads/complete/route";

test("legado soft concede após tempo sem prova de exibição (limite preservado)", async () => {
  let grants = 0;
  const handler = POST.createForTest({
    getUserFromRequest: async () => ({ userId: "test", role: "user", origem: "cookie", deviceId: null }),
    monetizacaoAtiva: () => true,
    isIpBlocked: async () => false,
    checkRateLimit: async () => ({ allowed: true, remaining: 1 }),
    consumirDesafio: async () => ({ userId: "test", plataforma: "android", tipo: "filme", finalidade: "reproducao", alvo: null, promocao: null, dispositivo: null, criadoEm: 0 }),
    agora: () => 7000,
    emitirConcessao: async () => { grants++; return "legacy-soft"; },
    marcarPago: async () => {},
  });
  const response = await handler(new Request("https://test/api/ads/complete", {
    method: "POST", body: JSON.stringify({ desafioId: "legacy", concluido: false }),
  }) as Parameters<typeof handler>[0]);
  assert.equal(response.status, 200);
  assert.equal(grants, 1);
});

test("Play bloqueia autoplay antes de criar contagem", () => {
  const hook = readFileSync("src/components/player/useAnuncio.tsx", "utf8");
  assert.ok(hook.indexOf('if (ehClientePlayNoNavegador()) {') > 0);
  assert.ok(hook.indexOf('if (ehClientePlayNoNavegador()) {') < hook.indexOf('const contagem = criarContagemAndroid'));
  const bridge = readFileSync("android/app/src/main/java/com/obaflix/ads/AdsBridge.kt", "utf8");
  assert.match(bridge, /if \(BuildConfig.PLAY_STORE_BUILD\)/);
  assert.match(bridge, /setPositiveButton\("Assistir anúncio e continuar"\)/);
});

test("startup de publicidade é desativado até validar elegibilidade/CMP, sem nova regra 18+", () => {
  const manifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
  assert.match(manifest, /com\.my\.target\.autoInitMode" android:value="0"/);
  assert.match(manifest, /AdsSdkInitializer" tools:node="remove"/);
  const consent = readFileSync("android/app/src/main/java/com/obaflix/ads/AdConsent.kt", "utf8");
  assert.match(consent, /!BuildConfig\.ADS_AUDIENCE_VALIDATED/);
  assert.equal(consent.includes("18 anos"), false);
  const build = readFileSync("android/app/build.gradle", "utf8");
  assert.match(build, /'ADS_AUDIENCE_VALIDATED', 'false'/);
  assert.match(consent, /info\.canRequestAds\(\)/);
  assert.match(consent, /purposes\.startsWith\("1"\)/);
});

test("recuperação do renderer remove o banner antes de substituir a WebView", () => {
  const source = readFileSync("android/app/src/main/java/com/obaflix/MainActivity.kt", "utf8");
  const recovery = source.slice(source.indexOf("private fun rebuildWebViewAposCrash"));
  assert.ok(recovery.indexOf("adsBridge?.suspendAds()") >= 0);
  assert.ok(recovery.indexOf("adsBridge?.suspendAds()") < recovery.indexOf("container.removeView(dead)"));
});
