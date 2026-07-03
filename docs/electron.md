# Electron — App Desktop (Windows)

## Localização

```
desktop/
  electron/
    main.js       ← processo principal (Node.js)
    preload.js    ← bridge IPC → renderer
    updater.js    ← electron-updater (auto-update)
  package.json
  build/
    icon.ico
```

## Detecção no Frontend

O renderer detecta o Electron verificando `window.obaflixDesktop`:

```typescript
const inElectron = typeof window !== "undefined" && !!(window as any).obaflixDesktop;
// ou: const desktop = (window as any).obaflixDesktop;
```

O objeto `obaflixDesktop` é exposto via `contextBridge` em `preload.js`:

```javascript
contextBridge.exposeInMainWorld("obaflixDesktop", {
  extractStream: (embedUrl) => ipcRenderer.invoke("extract-stream", embedUrl),
  toggleFullscreen: ()      => ipcRenderer.invoke("toggle-fullscreen"),
  getVersion: ()            => ipcRenderer.invoke("get-version"),
  installUpdate: ()         => ipcRenderer.invoke("install-update"),
});
```

## Por que o Electron é Necessário

> Esta seção foi escrita quando só rola3/rola4 tinham extração nativa. O mecanismo hoje é
> genérico (PlayHide, LuluVid, Rola2, Wish, Bolt e Big também) — ver
> [player-native-extraction.md](player-native-extraction.md) para o mapa completo. O raciocínio
> de IP-bound abaixo continua válido para rola3/rola4; para os demais providers o ganho
> principal é evitar o proxy de segmentos pela Vercel (latência/timeout), não o bloqueio de IP.

Os streams do rola3/rola4 usam CDN com tokens IP-bound. O token é válido apenas para o IP que fez a requisição de extração.

- **Na Web:** o servidor Vercel faz o fetch da extração. O token fica vinculado ao IP do Vercel. Quando o browser tenta acessar o CDN (IP diferente), recebe 403.
- **No Electron:** `main.js` faz o fetch de extração com o IP do usuário. O token fica vinculado ao IP do usuário. O browser acessa o CDN direto (bypass Vercel via `onBeforeRequest`). CDN valida: IPs coincidem → 200.

## Fluxo de Extração (IPC)

```
CustomPlayer.tsx
  desktop.extractStream(embedUrl)
    │
    ipcRenderer.invoke("extract-stream", embedUrl)
    │
main.js: ipcMain.handle("extract-stream")
    │
    extractSecuredLink(embedUrl)
    │
    POST embedUrl/player/index.php?data=<id>&do=getVideo
    headers: { Referer: embedUrl, X-Requested-With: XMLHttpRequest }
    │
    retorna { stream, embedOrigin }
    │
    playerState.cdnHostname = new URL(stream).hostname
    playerState.embedReferer = embedUrl
    │
    retorna { stream, tipo: "hls", referer: embedUrl }
    │
renderer recebe data
    │
    buildElectronProxyUrl(data.stream, data.referer)
    → "/api/player/proxy?url=<cdnUrl>&native=1&ref=<embedUrl>"
    │
    JW Player carrega a URL
```

## onBeforeRequest — Interceptação de Requests

Electron permite apenas **um** `onBeforeRequest` por sessão. O handler unificado em `configureSession()` cobre dois casos:

### Caso 1: Extração nativa → Servidor Local

```javascript
if (url.pathname === "/api/player/extract") {
  const embedUrl = url.searchParams.get("url");
  const hasNativeExtractor = !!detectProvider(embedUrl); // extractors.js — qualquer provider suportado
  if (hasNativeExtractor && localPort) {
    callback({ redirectURL: `http://127.0.0.1:${localPort}/extract?embedUrl=...` });
    return;
  }
}
```

Redireciona `/api/player/extract` para o servidor local Node.js (porta aleatória) quando
`detectProvider()` (em `extractors.js`) reconhece o provider — rola3/rola4, PlayHide, LuluVid,
Rola2, Wish, Bolt ou Big. O servidor local usa `fetch()` nativo do Node.js (IP do usuário). Ver
[player-native-extraction.md](player-native-extraction.md).

### Caso 2: Proxy → CDN Direto

```javascript
if (url.pathname === "/api/player/proxy") {
  const cdnUrl = url.searchParams.get("url");
  const hasSig = url.searchParams.has("sig");
  const isNativeRola34 = url.searchParams.get("native") === "1";
  const shouldBypass = !!cdnUrl && !hasSig && (hasNativeParam ? isNativeRola34 : true);
  if (shouldBypass) {
    callback({ redirectURL: cdnUrl });
    return;
  }
}
```

**Critério `native=1`:** `buildElectronProxyUrl()` no CustomPlayer sempre inclui `native=1` nas URLs rola3/4. URLs com `sig=` são segmentos do proxy W3 (token vinculado ao IP do Vercel) — jamais bypassar.

**Fallback sem `native=`:** cobre bundle do site em cache sem o marcador.

## onBeforeSendHeaders — Injeção de Headers

Handler único injetando em **todos** os requests:

1. **User-Agent** — sobrescreve em todo request para simular Chrome real
2. **Embed players** — injeta `Referer: obaflix.vercel.app/` e `X-Requested-With: XMLHttpRequest` em POST
3. **CDN** — lê `playerState.cdnHostname` / `playerState.embedReferer` e injeta `Referer` + `Origin` nos requests para o CDN

```javascript
const playerState = {
  cdnHostname: null,   // ex: "cdn.dahds13.xyz"
  embedReferer: null,  // ex: "https://embedplayer2.xyz/v/abc123"
};
```

`playerState` é atualizado pelo servidor local (path `/extract`) e pelo handler IPC (`extract-stream`) após extração bem-sucedida.

## onHeadersReceived — Remoção do CSP

```javascript
ses.webRequest.onHeadersReceived({ urls: [`${OBAFLIX_URL}/*`] }, (details, callback) => {
  const rh = { ...details.responseHeaders };
  delete rh["content-security-policy"];
  delete rh["Content-Security-Policy"];
  delete rh["content-security-policy-report-only"];
  callback({ responseHeaders: rh });
});
```

O Vercel serve CSP com `connect-src 'self'`, que bloquearia requests do renderer para CDNs externos mesmo com `webSecurity: false` (CSP é independente do SOP). O CSP é removido para permitir o redirect `proxy → CDN`.

## Servidor Local (porta aleatória)

Iniciado em `app.whenReady()` na porta `0` (SO escolhe). Serve apenas `127.0.0.1`:

```
GET  /extract?embedUrl=<url>
  → extractSecuredLink(embedUrl)
  → { stream, tipo, referer }
```

Necessário para o fluxo via `onBeforeRequest` redirect (alternativa ao IPC). Ambos os paths (IPC e local server) são equivalentes; o local server cobre o redirect do browser, o IPC cobre a chamada direta do CustomPlayer.

## Auto-Update

`desktop/electron/updater.js` usa `electron-updater`:

- Feed: GitHub Releases do repositório
- Verifica atualizações ao iniciar
- Notifica o renderer via evento IPC
- Usuário confirma → `autoUpdater.quitAndInstall(false, true)`
- O renderer expõe `obaflixDesktop.installUpdate()`

## Atalhos de Teclado

| Tecla | Ação |
|-------|------|
| F11 | Toggle fullscreen |
| F5 | Reload da página |
| F12 | DevTools |
| Escape | Sai do fullscreen |

## Configuração da Janela

```javascript
new BrowserWindow({
  width: 1280, height: 720, minWidth: 800, minHeight: 500,
  backgroundColor: "#111116",
  webPreferences: {
    preload: "preload.js",
    contextIsolation: true,
    nodeIntegration: false,           // segurança
    autoplayPolicy: "no-user-gesture-required",
    partition: "persist:obaflix",     // sessão persistente
    webSecurity: false,               // permite redirect CDN
  },
});
```

`webSecurity: false` é necessário para o redirect `onBeforeRequest` para o CDN funcionar. Sem isso, o Electron bloqueia mixed-content e redirects cross-origin no renderer.

## Build e Distribuição

```bash
cd desktop
npm install
npm run build   # electron-builder → dist/Obaflix Setup 1.x.x.exe
```

O `package.json` do desktop define:
- `appId`: identificador único do app
- `publish`: GitHub Releases (para auto-update)
- `win.target`: `["nsis"]` (installer) ou `["portable"]`

O `.exe` resultante inclui todos os assets; o site Vercel **não** está embutido — o app carrega `OBAFLIX_URL` em runtime.

## EMBED_HOSTNAMES

Lista de domínios que o Electron reconhece como embed players (injeção de headers + navegação permitida):

```javascript
const EMBED_HOSTNAMES = [
  "embedplayer2.xyz", "embedplayer1.xyz",
  "xn--kcksk7a2bl5le7b6doc1h3f.com", "llanfairpwllgwyngy.com",
  "playhide.shop", "streamwish.com", "hlswish.com",
  "playerwish.com", "jvrkt.online", "beamy.online",
  "boltcdn.xyz", "bigshare.link", "luluvdo.com",
];
```

Ver [player-native-extraction.md](player-native-extraction.md) para o passo a passo completo de
como adicionar um novo provider (4 arquivos: `route.ts`, `extractors.js`, `PlayerExtractors.kt`,
`CustomPlayer.tsx`). Adicionar apenas o hostname aqui não é suficiente.
