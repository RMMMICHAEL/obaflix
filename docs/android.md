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
  ├── SE url.path == /api/player/extract && PlayerExtractors.detectProvider(embedUrl) != null:
  │   → StreamExtractor.extract(embedUrl) via OkHttp (rola3/4, hide, lulu, rola2, wish, bolt, big)
  │   → retorna WebResourceResponse com JSON local
  │
  ├── SE url.path == /api/player/proxy && native=1 && !sig:
  │   → OkHttp fetch(cdnUrl) com Referer/Origin injetado
  │   → retorna WebResourceResponse (bytes do CDN) — cobre o manifest
  │
  ├── SE url.host == playerState.cdnHostname (ou subdomínio):
  │   → mesmo fetchCdnDirect() acima — cobre segmentos/sub-playlists/chaves
  │     buscados com URL absoluta pelo hls.js, fora do path /api/player/proxy
  │
  └── SE request.isForMainFrame && url.host contém obaflix/vercel:
      → refaz o fetch via OkHttp com cookies do CookieManager injetados
      → remove CSP da resposta, sincroniza Set-Cookie de volta no CookieManager
```

Ver seção "Rola3/Rola4 — Divergência de Comportamento vs Electron e Correção" abaixo para o
raciocínio completo por trás dos branches 3 e 4 (por que existem, e a limitação de WebView
que motivou a implementação do branch 4).

## StreamExtractor — Extração com IP do Usuário

> `StreamExtractor.extract()` hoje é um dispatcher fino sobre `PlayerExtractors.extract()`
> (`bridge/PlayerExtractors.kt`), que roteia por provider (rola3/4, PlayHide, LuluVid, Rola2,
> Wish, Bolt, Big) via `detectProvider()`. O trecho abaixo mostra a lógica original,
> específica de rola3/4 (`extractEmbedPlayer` em `PlayerExtractors.kt` hoje) — mantido aqui
> como exemplo do padrão de requisição. Ver [player-native-extraction.md](player-native-extraction.md).

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

## Rola3/Rola4 (Embv/Xnn) — Divergência de Comportamento vs Electron e Correção

### Sintoma

Os players tokenizados (rola3/rola4, exibidos como "Embv"/"Xnn") extraíam o stream com
sucesso (a chamada `extractStream` retornava `stream`/`referer`), mas o vídeo falhava ao
carregar ou travava logo após o primeiro frame — enquanto no Electron (`.exe`) os mesmos
players funcionavam normalmente.

### Causa raiz nº 1 — CDN bypass cobria só a primeira requisição

`buildElectronProxyUrl()` (em `CustomPlayer.tsx`, compartilhado entre as duas plataformas)
monta a URL do manifest como `/api/player/proxy?url=<cdnUrl>&native=1`. O manifest (HLS
`master.m3u8`) referencia segmentos, sub-playlists de áudio e chaves de criptografia com
**URLs absolutas apontando direto para o CDN** — o player (hls.js dentro do JW Player) busca
esses recursos diretamente, fora do path `/api/player/proxy`.

- **Electron:** `onBeforeSendHeaders` é registrado para `*://*/*` — cobre **qualquer**
  requisição da sessão, incluindo essas buscas diretas ao CDN, injetando `Referer`/`Origin`
  sempre que o host bate com `playerState.cdnHostname`.
- **Android (antes da correção):** `shouldInterceptRequest` só reagia a
  `path == "/api/player/proxy"` — ou seja, só a primeira requisição (o manifest) recebia
  `Referer`/`Origin`/CORS. Os segmentos e sub-playlists buscados depois, com URL absoluta do
  CDN, caíam em `return null` (sem interceptação) e saíam pela rede nativa da WebView sem
  nenhum header injetado → o CDN rejeitava (403) por Referer ausente/incorreto.

**Fix:** novo branch 3 em `PlayerWebViewClient.shouldInterceptRequest()` — qualquer requisição
cujo host seja igual a `ObaflixApp.playerState.cdnHostname` (ou subdomínio dele) passa pelo
mesmo `fetchCdnDirect()` usado pelo manifest, reproduzindo o comportamento universal do
`onBeforeSendHeaders` do Electron.

### Causa raiz nº 2 — CSP bloqueia o fetch cross-origin antes mesmo da interceptação

Mesmo com o branch 3 acima, o fetch para o CDN é iniciado pelo **JavaScript da própria
página** (`hls.js` faz `fetch()`/XHR para a URL absoluta do CDN). O header
`Content-Security-Policy: connect-src 'self'`, enviado pelo Vercel em toda resposta HTML, é
avaliado pelo motor de renderização **antes** da requisição chegar à camada de rede — ou
seja, antes de `shouldInterceptRequest` ter qualquer chance de interceptá-la. Sem remover o
CSP, o próprio browser (Chromium embutido na WebView) bloqueia a tentativa de fetch
cross-origin ao CDN, e o branch 3 nunca é sequer alcançado.

O Electron sofre exatamente do mesmo problema e por isso remove o CSP via
`onHeadersReceived` (ver [electron.md](electron.md)). A tentativa anterior de replicar isso
no Android (`fetchWithoutCsp`, removida em 2026-07-01 — ver `android_session_notes.md`) quebrou
a autenticação porque **`WebResourceRequest.requestHeaders` nunca inclui o header `Cookie`**
(nem `User-Agent`) — é uma omissão deliberada da API do Android, não um bug: refazer o fetch
do documento via OkHttp sem repor esse header manualmente resulta numa página carregada sem
sessão (NextAuth), causando erro de hidratação do Next.js.

**Fix:** `fetchDocumentWithoutCsp()`, restrito a `request.isForMainFrame == true` (só a
navegação de topo — o CSP vale para toda a vida do documento; navegação client-side do
Next.js não refaz a requisição de documento, então não precisa reinterceptar):

1. Lê os cookies atuais do domínio via `CookieManager.getInstance().getCookie(url)` — a mesma
   fonte que a WebView usa nativamente — e os injeta manualmente como header `Cookie` na
   requisição OkHttp.
2. Após a resposta, sincroniza qualquer `Set-Cookie` de volta no `CookieManager` (a resposta
   veio via OkHttp, fora do fluxo nativo da WebView; nada faria essa sincronização
   automaticamente).
3. Remove os headers `Content-Security-Policy`/`-Report-Only` da resposta antes de devolvê-la.

### Limitação de WebView documentada

`WebResourceRequest.requestHeaders` (Android WebView API) **nunca** expõe os headers `Cookie`
e `User-Agent` reais da requisição a `shouldInterceptRequest`, mesmo que a WebView os envie
normalmente pela rede. Isso é documentado no comportamento da API (não há flag para mudar
isso). Qualquer interceptação que refaça uma requisição autenticada via um cliente HTTP
próprio (OkHttp, neste caso) **precisa repor manualmente** essas credenciais lendo-as de
`CookieManager` — não existe forma de "herdar" o contexto de rede da WebView diretamente.
Isso não tem equivalente no Electron: `session.webRequest.onHeadersReceived`/
`onBeforeSendHeaders` operam **dentro da mesma sessão de rede do Chromium**, sem nunca
precisar refazer a requisição por fora — por isso o Electron não tem esse problema.

## Diferenças de Comportamento vs Electron

| Funcionalidade | Electron | Android |
|----------------|----------|---------|
| Extração rola3/4 | IPC → Node.js `fetch` | `shouldInterceptRequest` → OkHttp |
| CDN bypass (manifest) | `onBeforeRequest` redirect real | `shouldInterceptRequest` → OkHttp, resposta sintetizada |
| CDN bypass (segmentos/sub-playlists) | `onBeforeSendHeaders` universal (`*://*/*`) | `shouldInterceptRequest` branch dedicado por hostname (`cdnHostname`) |
| CSP removal | `onHeadersReceived`, dentro da mesma sessão de rede | `shouldInterceptRequest` refaz fetch via OkHttp + `CookieManager` (só `isForMainFrame`) |
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
