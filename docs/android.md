# Android — APK WebView

## Localização

```
android/
  app/
    src/main/
      java/com/obaflix/
        MainActivity.kt           ← Activity principal + WebView setup
        ObaflixApp.kt             ← Application class (OkHttp singleton)
        bridge/
          ObaflixBridge.kt        ← JavascriptInterface (substitui preload.js)
          StreamExtractor.kt      ← Extração nativa (substitui main.js extract)
        player/
          PlayerWebViewClient.kt  ← WebViewClient (substitui onBeforeRequest + headers)
      AndroidManifest.xml
      res/
        layout/activity_main.xml
        values/strings.xml
  app/build.gradle
  build.gradle
  settings.gradle
  gradle.properties
  gradle/wrapper/gradle-wrapper.properties
```

## Equivalências Electron → Android

| Electron | Android | Propósito |
|----------|---------|-----------|
| `preload.js` + `contextBridge` | `ObaflixBridge.kt` + `@JavascriptInterface` | Expõe `window.obaflixDesktop` |
| `ipcMain.handle("extract-stream")` | `StreamExtractor.kt` (OkHttp) | Extrai stream com IP do usuário |
| `onBeforeRequest` | `shouldInterceptRequest()` | Redireciona CDN / servidor local |
| `onBeforeSendHeaders` | `shouldInterceptRequest()` + headers | Injeta Referer, Origin, UA |
| `onHeadersReceived` (remove CSP) | `shouldInterceptRequest()` | Remove CSP nas respostas |
| `ses.webRequest.*` (um por sessão) | `WebViewClient` unificado | Interceptação de requests |

## Detecção no Frontend

O JavaScript detecta o Android da mesma forma que o Electron:

```typescript
const inElectron = !!(window as any).obaflixDesktop;
// ou
const desktop = (window as any).obaflixDesktop;
```

`ObaflixBridge` expõe o mesmo objeto `obaflixDesktop` via `@JavascriptInterface`.

## ObaflixBridge — JavascriptInterface

```kotlin
@JavascriptInterface
fun extractStream(embedUrl: String) {
  // Dispara coroutine → StreamExtractor.extract(embedUrl)
  // Resultado: chama JS window._obaflixCallback(id, json)
}
```

Como `@JavascriptInterface` não suporta Promises, a bridge usa callbacks:

**JavaScript (no site):**
```javascript
window.obaflixDesktop = {
  extractStream(embedUrl) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      window._obaflixCallbacks = window._obaflixCallbacks || {};
      window._obaflixCallbacks[id] = { resolve, reject };
      window._obaflixBridge.extractStream(id, embedUrl); // chama o @JavascriptInterface
    });
  }
}
```

**ObaflixBridge.kt:**
```kotlin
webView.evaluateJavascript(
  "window._obaflixCallbacks['$id']?.resolve($jsonResult)"
, null)
```

O JavaScript bridge shim é injetado via `onPageFinished` em `MainActivity`.

## PlayerWebViewClient — shouldInterceptRequest

Substitui os três handlers do Electron em um único método:

```
shouldInterceptRequest(view, request)
  │
  ├── SE url.path == /api/player/extract && isRola34Url:
  │   → StreamExtractor.extract(embedUrl) via OkHttp
  │   → retorna WebResourceResponse com JSON local
  │
  ├── SE url.path == /api/player/proxy && native=1 && !sig:
  │   → OkHttp fetch(cdnUrl) com Referer injetado
  │   → retorna WebResourceResponse (bytes do CDN)
  │
  └── SE url.host == obaflix.vercel.app:
      → fetch normal, mas remove CSP da resposta
```

**Remoção do CSP:** `WebViewClient.shouldInterceptRequest` retorna `WebResourceResponse` com headers modificados — a resposta com `Content-Security-Policy` é substituída por uma versão sem esse header.

## StreamExtractor — Extração com IP do Usuário

```kotlin
object StreamExtractor {
  private val client = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(15, TimeUnit.SECONDS)
    .build()

  suspend fun extract(embedUrl: String): ExtractResult {
    val parsed = URL(embedUrl)
    val id = parsed.path.split("/").last { it.isNotEmpty() }
    val apiUrl = "${parsed.protocol}://${parsed.host}/player/index.php?data=$id&do=getVideo"

    val body = FormBody.Builder()
      .add("hash", id)
      .add("r", OBAFLIX_URL + "/")
      .build()

    val request = Request.Builder()
      .url(apiUrl)
      .post(body)
      .addHeader("X-Requested-With", "XMLHttpRequest")
      .addHeader("Referer", embedUrl)
      .addHeader("Origin", "${parsed.protocol}://${parsed.host}")
      .addHeader("User-Agent", UA)
      .build()

    val response = client.newCall(request).execute()
    val json = JSONObject(response.body!!.string())
    val stream = json.optString("securedLink")
      ?: json.optString("videoSource")
      ?: json.optString("src")
      ?: throw Exception("stream não encontrado")

    return ExtractResult(stream = stream, referer = embedUrl)
  }
}
```

## playerState — Estado do CDN

Equivalente ao `playerState` do Electron:

```kotlin
data class PlayerState(
  var cdnHostname: String? = null,
  var embedReferer: String? = null,
)

// Em ObaflixApp.kt (singleton)
val playerState = PlayerState()
```

Atualizado após extração bem-sucedida. Lido por `PlayerWebViewClient` para injetar `Referer` nos requests CDN.

## WebView — Configuração

```kotlin
webView.settings.apply {
  javaScriptEnabled = true
  domStorageEnabled = true
  mediaPlaybackRequiresUserGesture = false  // autoplay de mídia
  mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
  useWideViewPort = true
  loadWithOverviewMode = true
  builtInZoomControls = false
  displayZoomControls = false
}
webView.addJavascriptInterface(ObaflixBridge(webView, scope), "_obaflixBridge")
webView.webViewClient = PlayerWebViewClient()
webView.loadUrl(OBAFLIX_URL)
```

## Fullscreen de Vídeo

```kotlin
webView.webChromeClient = object : WebChromeClient() {
  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    // Esconde a WebView, mostra `view` em fullscreen
    container.addView(view)
    window.decorView.systemUiVisibility = SYSTEM_UI_FLAG_FULLSCREEN or ...
  }
  override fun onHideCustomView() {
    // Restaura WebView
  }
}
```

## Permissões

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

Apenas INTERNET é necessário. Sem acesso a câmera, microfone ou storage.

## Diferenças de Comportamento vs Electron

| Funcionalidade | Electron | Android |
|----------------|----------|---------|
| Extração rola3/4 | IPC → Node.js `fetch` | `shouldInterceptRequest` → OkHttp |
| CDN bypass | `onBeforeRequest` redirect | `shouldInterceptRequest` OkHttp proxy |
| CSP removal | `onHeadersReceived` delete | `shouldInterceptRequest` headers filtrados |
| Fullscreen | `mainWindow.setFullScreen()` | `WebChromeClient.onShowCustomView` |
| Auto-update | `electron-updater` | Download do APK via browser |
| Instância única | `requestSingleInstanceLock` | `android:launchMode="singleTask"` |

## Build

```bash
cd android
./gradlew assembleRelease    # APK em app/build/outputs/apk/release/
./gradlew assembleDebug      # APK de debug
```

**Keystore:** configurar em `android/key.properties` (não commitado):
```
storeFile=../obaflix.jks
storePassword=...
keyAlias=obaflix
keyPassword=...
```

## URLs do App

`OBAFLIX_URL` em `app/build.gradle`:
```gradle
buildConfigField "String", "OBAFLIX_URL", '"https://obaflix.vercel.app"'
```

Para apontar para dev: alterar para `"http://10.0.2.2:3000"` (emulador) ou IP local (dispositivo físico).

## Compatibilidade

- `minSdk`: 26 (Android 8.0 Oreo) — WebView System WebView atualizado, OkHttp 4
- `targetSdk`: 34 (Android 14)
- `compileSdk`: 34
