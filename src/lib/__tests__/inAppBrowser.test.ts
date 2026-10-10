import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInAppBrowser, isAndroidInAppBrowser } from "../in-app-browser";

// User-Agents representativos e próximos dos reais de cada cliente.
const UA = {
  tiktok:
    "Mozilla/5.0 (Linux; Android 12; SM-G973F Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.105 Mobile Safari/537.36 trill_2022803030 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/28.3.3 ByteLocale/pt BytedanceWebview/d8a21c6",
  tiktokMinimo:
    "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Mobile Safari/537.36 BytedanceWebview/d8a21c6",
  webview:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ2A.230505.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.5672.136 Mobile Safari/537.36",
  instagram:
    "Mozilla/5.0 (Linux; Android 12; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 Instagram 250.0.0.21.109 Android (31/12; 420dpi; 1080x2277; samsung)",
  facebook:
    "Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/300.0.0.44.120;]",
  chrome:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/21.0 Chrome/110.0.5481.154 Mobile Safari/537.36",
  firefox:
    "Mozilla/5.0 (Android 13; Mobile; rv:115.0) Gecko/115.0 Firefox/115.0",
  edge:
    "Mozilla/5.0 (Linux; Android 10; HD1913) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 EdgA/114.0.1823.43",
  desktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
  // Aplicativo Android oficial do Obaflix: WebView (tem `; wv)`) mas marcado com
  // ObaflixApp/ — não pode ser empurrado para "abrir no navegador".
  obaflixApp:
    "Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/115.0.0.0 Mobile Safari/537.36 ObaflixApp/1.0.19",
  obaflixDesktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Obaflix/0.7.30 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36 ObaflixDesktop/0.7.30",
};

test("TikTok/ByteDance WebView no Android é in-app", () => {
  assert.equal(detectInAppBrowser(UA.tiktok), "tiktok");
  assert.equal(detectInAppBrowser(UA.tiktokMinimo), "tiktok");
  assert.equal(isAndroidInAppBrowser(UA.tiktok), true);
});

test("WebView genérico do Android é in-app", () => {
  assert.equal(detectInAppBrowser(UA.webview), "android-webview");
  assert.equal(isAndroidInAppBrowser(UA.webview), true);
});

test("Instagram e Facebook no Android são in-app", () => {
  assert.equal(detectInAppBrowser(UA.instagram), "instagram");
  assert.equal(detectInAppBrowser(UA.facebook), "facebook");
});

test("navegadores normais do Android não são in-app", () => {
  for (const ua of [UA.chrome, UA.samsung, UA.firefox, UA.edge]) {
    assert.equal(detectInAppBrowser(ua), "browser", ua);
    assert.equal(isAndroidInAppBrowser(ua), false, ua);
  }
});

test("desktop nunca é in-app", () => {
  assert.equal(detectInAppBrowser(UA.desktop), "browser");
  assert.equal(isAndroidInAppBrowser(UA.desktop), false);
});

test("UA vazio ou lixo recai conservadoramente em browser", () => {
  for (const ua of ["", "   ", undefined as unknown as string, null as unknown as string, "não é um user agent"]) {
    assert.equal(detectInAppBrowser(ua), "browser");
    assert.equal(isAndroidInAppBrowser(ua), false);
  }
});

test("aplicativos oficiais Obaflix (Android e Electron) nunca são in-app", () => {
  assert.equal(detectInAppBrowser(UA.obaflixApp), "browser");
  assert.equal(isAndroidInAppBrowser(UA.obaflixApp), false);
  assert.equal(detectInAppBrowser(UA.obaflixDesktop), "browser");
});

test("in-app só vale no Android: mesma marca em iOS não é classificada", () => {
  const instagramIos =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 250.0.0.21.109 (iPhone14,5; iOS 16_5)";
  assert.equal(detectInAppBrowser(instagramIos), "browser");
});
