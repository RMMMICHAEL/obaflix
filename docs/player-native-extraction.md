# Extração Nativa Multi-Provider (Electron + Android)

## Contexto

Comparado ao MegaFlix (Electron/WebView reproduzindo direto do CDN, sem proxy de segmentos),
o Obaflix só tinha esse comportamento para **rola3/rola4**. Todo o resto — PlayHide, LuluVid,
Rola2, Wish, Bolt, Big — mesmo rodando dentro do `.exe`/APK, caía no fluxo Web: extração no
servidor Vercel + **cada segmento HLS proxiado** por `/api/player/proxy` (ver
[proxy.md](proxy.md)). Isso causava buffering/travamento (segmentos lentos por trás de uma
função serverless com timeout de 20s) e, no caso do Lulu, bloqueio total quando a extração
falhava e o player caía no fallback `<iframe sandbox>` — a própria página do Lulu detecta o
sandbox restrito e mostra "Streaming Blocked".

Este documento descreve a arquitetura genérica que estende o bypass nativo (extração com IP
residencial do usuário + CDN direto, sem proxy Vercel) para **todos os providers suportados**.

## Mapa de Providers

| Provider (UI) | Detecção (hostname/pathname) | Extrator nativo | Web (fallback) |
|---|---|---|---|
| Embv (rola3) | `/rola3/` ou `embedplayer` | `extractEmbedPlayer` | `route.ts` → Worker/direto |
| Xnn (rola4) | `/rola4/` ou `xn--kcksk7a2bl5le7b6doc1h3f` | `extractEmbedPlayer` | idem |
| PlayHide | `hide` no hostname | `extractHide` | `route.ts extractHide` |
| LuluVid | `lulu` no hostname | `extractLulu` | `route.ts extractLulu` |
| Rola2 (Sp-f, legado) | `llanfair` no hostname ou `/rola/` | `extractRola2` | `route.ts extractRola` |
| Wish (Streamwish/Hlswish/Playerwish) | `wish` no hostname | `extractWish` | `route.ts extractWish` |
| Bolt | `bolt` no hostname | `extractBolt` | `route.ts extractBolt` |
| Big (Bigshare) | `bigshare`/`big` no hostname | `extractBig` | `route.ts extractBig` |
| WatchPlayer | `v1.watchplay.shop` | `extractWatchplayer` | `extractWatchplayer` (também usado pelo PlayerFlix atual) |
| Voltz | `voltz.php` em `megafrixapi.com` ou `vods.faz-o-eli.online` | `extractVoltz` | `extractVoltz` |

O site web (não-Electron/Android) continua **sempre** usando o fluxo `route.ts` +
`/api/player/proxy` para todos os providers — nada mudou para usuários web. A única mudança é
**quando `isDesktop === true`**, o player passa a preferir o bridge nativo para qualquer
provider da tabela acima, em vez de só rola3/rola4.

### WatchPlayer — provider diferente dos demais

WatchPlayer não vem do banco (`urlDub`/`urlLeg`) como todos os outros. Nos clientes nativos,
também existe como fonte sintética montada em `CustomPlayer.tsx` a partir do `tmdbId`. No site,
o endpoint atual do PlayerFlix devolve `v1.watchplay.shop` como primeira opção; por isso o
`extractPlayerflix()` delega ao mesmo algoritmo WatchPlayer no servidor.

O endpoint `playerflix.ink/inc/Ajax.php` expõe as opções reais em JSON. É um provider simples:
API JSON própria, sem packer/moon.php, sem Cloudflare, e o CDN final (`*.hclod.qzz.io`) não
exige nenhum header especial.

```
Filme:  GET  /movie/{tmdbId}                              → data-id já vem pronto no HTML
        POST /api  action=getPlayer&video_id={id}          → { data: { video_url } }

Série:  GET  /tvshow/{tmdbId}/{season}/{episode}            → data-contentid do episódio certo
        POST /api  action=getOptions&contentid={contentId} → { data: { options: [{ID, type}] } }
        POST /api  action=getPlayer&video_id={options[0].ID} → { data: { video_url } }
```

O algoritmo precisa permanecer equivalente em `route.ts`, Electron e Android. Mudanças no HTML
ou na API `getOptions`/`getPlayer` devem ser portadas para os três lados no mesmo commit.

## Arquivos

```
desktop/electron/extractors.js              ← extratores Node.js (Electron)
desktop/electron/main.js                    ← dispatcher + IPC + bypass CDN
android/.../bridge/PlayerExtractors.kt      ← extratores Kotlin (Android)
android/.../bridge/StreamExtractor.kt       ← dispatcher (wrapper fino sobre PlayerExtractors)
android/.../player/PlayerWebViewClient.kt   ← intercept + bypass CDN
src/components/player/CustomPlayer.tsx      ← decide quando usar o bridge nativo
```

`extractors.js` e `PlayerExtractors.kt` são portas 1:1 da mesma lógica de
`src/app/api/player/extract/route.ts` (mesmos regexes, mesmo algoritmo de packer, mesmo
`moon.php`) — só trocam `fetch` do Vercel por `fetch`/OkHttp rodando localmente, com o IP do
usuário. Ver [stream-extraction.md](stream-extraction.md) para o detalhe de cada algoritmo.

## Dois mecanismos, uma decisão

**`isTokenizedUrl(url)`** (`CustomPlayer.tsx`) — inalterado. Só reconhece rola3/rola4. Controla
exclusivamente **quais fontes aparecem na lista de players do site web** (`parseFontes`):
rola3/rola4 continuam ocultas para usuários web, porque não funcionam de jeito nenhum com IP de
datacenter (o token da API embedplayer é IP-bound desde a extração, não só nos segmentos).

**`supportsNativeDesktopExtraction(url)`** (`CustomPlayer.tsx`) — novo, superset de
`isTokenizedUrl`. Não filtra nada da lista de fontes — só decide, **quando `isDesktop` é
verdadeiro**, se a extração usa `desktop.extractStream()` (bridge nativo) em vez do fluxo web
(`/api/player/token` + `/api/player/extract` + proxy por segmento).

```typescript
if (desktop && supportsNativeDesktopExtraction(embedUrl)) {
  const data = await desktop.extractStream(embedUrl); // Electron IPC ou Android bridge
  // tipo/stream/referer usados para montar a URL do proxy com bypass direto ao CDN
} else {
  // fluxo web: /api/player/token → /api/player/extract → proxy por segmento
}
```

A mesma função também decide o critério de **renovação de token** (`runReExtract`) — antes só
rola3/rola4 tentavam renovar via IPC ao expirar; agora qualquer provider com extração nativa
tenta.

## Fluxo (Electron)

```
CustomPlayer.tsx: supportsNativeDesktopExtraction(embedUrl) === true
  │
  desktop.extractStream(embedUrl)  →  ipcRenderer.invoke("extract-stream", embedUrl)
  │
main.js: ipcMain.handle("extract-stream")
  │
  extractors.js: extractStream(embedUrl)
    │
    detectProvider(embedUrl) → "hide" | "lulu" | "rola2" | "wish" | "bolt" | "big" | "embedplayer"
    │
    extrator específico roda com fetch() do processo principal (IP do usuário, sem CORS)
  │
  retorna { stream, tipo }
  │
main.js atualiza playerState.cdnHostname / embedReferer
  │
renderer: buildElectronProxyUrl(stream, referer) → "/api/player/proxy?url=<cdn>&native=1&ref=..."
  │
onBeforeRequest bypassa direto pro CDN (cdnUrl presente, sem "sig") — sem passar pelo Vercel
  │
JW Player carrega o HLS direto do CDN
```

O `onBeforeRequest` que redireciona `/api/player/extract` para o servidor HTTP local (porta
127.0.0.1) agora usa `detectProvider(embedUrl) != null` em vez de checar só rola3/rola4 — cobre
qualquer provider da tabela. Esse caminho é um fallback defensivo (o caminho principal é o IPC
direto); existe para o caso de o bundle do site em cache ainda chamar a URL HTTP em vez do
bridge.

## Fluxo (Android)

Mesma decisão em `CustomPlayer.tsx` (`window.obaflixDesktop` é o mesmo objeto tanto no Electron
quanto no Android). No lado nativo:

```
ObaflixBridge.extractStream(callbackId, embedUrl)
  │
  StreamExtractor.extract(embedUrl)
    │
    PlayerExtractors.detectProvider(embedUrl) → dispatch
    │
    extrator específico roda via OkHttp (IP do usuário)
  │
  atualiza ObaflixApp.playerState
  │
  resolve callback JS com { stream, tipo, referer }
```

`PlayerWebViewClient.shouldInterceptRequest` também trocou `isRola34Url` por
`PlayerExtractors.detectProvider(embedUrl) != null` no branch que intercepta
`/api/player/extract` (mesmo papel do `onBeforeRequest` do Electron).

## Como adicionar um novo player

Um novo provider precisa de mudanças em **4 lugares**, sempre em conjunto:

1. **`src/app/api/player/extract/route.ts`** — extrator de referência (usado pelo site web).
   Se o provider ainda não existe aqui, comece por ele.
2. **`desktop/electron/extractors.js`** — porte o mesmo algoritmo para Node.js puro (sem
   `NextRequest`, usando `fetch` global). Adicione um `case` em `extractStream()` e um branch em
   `detectProvider()`.
3. **`android/.../bridge/PlayerExtractors.kt`** — porte o mesmo algoritmo para Kotlin/OkHttp.
   Adicione um `when` branch em `extract()` e um branch em `detectProvider()` — **mantenha os
   critérios de detecção idênticos** aos de `extractors.js` (mesmo hostname/pathname).
4. **`src/components/player/CustomPlayer.tsx`** — adicione o hostname em
   `supportsNativeDesktopExtraction()`. **Não** adicione em `isTokenizedUrl()` a menos que o
   provider também precise ser **ocultado do site web** (só faça isso se o provider for
   estruturalmente inviável sem IP residencial, como rola3/rola4).

Se o provider só precisa funcionar bem no site web (sem ganho perceptível no app nativo — ex.:
já é rápido via Vercel), pare no passo 1: não é obrigatório dar suporte nativo a todo provider.

## Voltz (`vods.faz-o-eli.online`)

As URLs atuais do catálogo usam `vods.faz-o-eli.online/voltz.php`. O host precisa permanecer
nas listas permitidas do servidor, Worker, Electron e Android. A detecção exige HTTPS, hostname
exato (ou subdomínio) e o path `voltz.php`; não volte a usar apenas `pathname.includes()` sem
validar o host, pois isso reabriria o extrator para destinos arbitrários.
