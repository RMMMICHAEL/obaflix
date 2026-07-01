# Arquitetura do Sistema

## Visão Geral

O Obaflix é uma plataforma de streaming composta por três clientes (Web, Electron, Android) que compartilham o mesmo backend Next.js hospedado no Vercel.

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTES                                  │
│                                                                   │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Navegador   │  │  Electron (Win)  │  │  Android (APK)   │  │
│  │  (Web puro)  │  │  WebView + IPC   │  │  WebView + Bridge│  │
│  └──────┬───────┘  └────────┬─────────┘  └────────┬─────────┘  │
│         │                   │                       │             │
└─────────┼───────────────────┼───────────────────────┼───────────┘
          │                   │                       │
          └───────────────────┴───────────────────────┘
                              │
                    HTTPS (obaflix.vercel.app)
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│                    VERCEL (Next.js 14)                            │
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  SSR Pages  │  │  API Routes  │  │  Static Assets       │  │
│  │  /assistir  │  │  /api/*      │  │  JW Player, imagens  │  │
│  └─────────────┘  └──────┬───────┘  └──────────────────────┘  │
│                           │                                       │
│  ┌────────────────────────▼────────────────────────────────┐    │
│  │              Camada de Dados                              │    │
│  │  Prisma ORM ──► PostgreSQL   Upstash Redis (REST)        │    │
│  │  (conteúdo, usuários,        (tokens, rate limit,        │    │
│  │   progresso, watchlist)       concorrência, metrics)      │    │
│  └────────────────────────────────────────────────────────--┘    │
└─────────────────────────────────────────────────────────────────┘
          │                                   │
          ▼                                   ▼
   CDN Provedores                    Cloudflare Worker
   (rola3/4 CDN,                     (extração rola3/4
    playhide CDN,                     com IP do worker)
    streamwish CDN)
```

## Fluxo Completo de Reprodução (Web)

```
Usuário clica "Assistir"
        │
        ▼
  POST /api/player/token
  ├── Verifica sessão NextAuth
  ├── Rate limit (20 req/min por user)
  ├── Gera PlayToken (HMAC-SHA256)
  │   └── vincula: userId + embedUrl + clientIP + exp(5min)
  └── Retorna { playToken }
        │
        ▼
  GET /api/player/extract?url=<embed>&playToken=<token>
  ├── Verifica sessão + PlayToken
  ├── doExtract(url)
  │   ├── Identifica provider pelo hostname/pathname
  │   ├── Executa extrator específico (HTML scraping / API)
  │   └── Retorna { stream: "https://cdn.../master.m3u8", tipo: "hls" }
  ├── createStreamToken(userId, streamUrl, referer, ip, ua)
  │   ├── Limite: 3 streams simultâneos por user (Redis sorted set)
  │   ├── Criptografa com AES-256-GCM
  │   └── Armazena em Redis (SET NX, TTL 20min, single-use)
  └── Retorna { tipo: "hls", streamToken: "<opaque>" }
        │
        ▼
  JW Player carrega /api/player/proxy?t=<streamToken>
  ├── Verifica sessão + resolve StreamToken
  │   ├── Redis GET → decrypt → valida IP/UA
  │   └── Redis DEL (single-use: token consumido)
  ├── fetch(streamUrl) com headers corretos (Referer, Origin, UA)
  ├── Se M3U8: reescreve URLs dos segmentos com HMAC
  │   └── /api/player/proxy?url=<segUrl>&sig=<hmac>
  └── Stream → JW Player
        │
        ▼
  JW Player solicita cada segmento
  /api/player/proxy?url=<segUrl>&sig=<hmac>
  ├── Verifica sessão + verifySegmentUrl(url, userId, sig)
  └── fetch(segUrl) → retorna bytes
```

## Fluxo Electron (rola3/rola4)

```
Electron detecta URL com native=1
        │
        ▼
  main.js onBeforeRequest intercepta
  /api/player/proxy?url=<cdnUrl>&native=1
        │
        ├── redirectURL → cdnUrl direto (bypass Vercel proxy)
        │   (token CDN é IP-bound ao IP do usuário, não do Vercel)
        │
        └── Para extração (/api/player/extract com rola3/4):
            main.js redireciona → http://127.0.0.1:<port>/extract
            servidor local usa fetch() com IP do usuário
```

## Fluxo Android (rola3/rola4)

```
Android ObaflixBridge.extractStream(embedUrl)
        │
        ▼
  StreamExtractor.kt (OkHttp)
  POST <embed>/player/index.php?data=<id>&do=getVideo
  headers: { Referer: embedUrl, X-Requested-With: XMLHttpRequest }
        │
        ▼
  Retorna { stream, referer }
        │
        ▼
  JavaScript recebe via callback
  buildElectronProxyUrl(stream, referer)
        │
        ▼
  PlayerWebViewClient.shouldInterceptRequest()
  intercepta /api/player/proxy?url=<cdnUrl>&native=1
  OkHttp fetch(cdnUrl) com Referer correto
  retorna WebResourceResponse
```

## Diferenças entre Plataformas

| Funcionalidade | Web | Electron | Android |
|----------------|-----|----------|---------|
| Extração rola3/4 | Worker/API Vercel | IPC → main.js Node.js | Bridge → StreamExtractor.kt OkHttp |
| CDN bypass | Não (proxied via Vercel) | `onBeforeRequest` redirect | `shouldInterceptRequest` intercept |
| CSP | Enforced pelo Vercel | Removido por `onHeadersReceived` | Removido por `shouldInterceptRequest` headers |
| Referer CDN | Proxy Vercel injeta | `onBeforeSendHeaders` injeta | `shouldInterceptRequest` injeta |
| Atualização | Automática (Vercel) | electron-updater + GitHub | APK download ou Play Store |
| `window.obaflixDesktop` | undefined | preload.js expõe | JavascriptInterface expõe |

## Componentes-Chave por Responsabilidade

```
Responsabilidade                  Arquivo(s)
────────────────────────────────────────────────────────────────
Player UI + recovery              src/components/player/CustomPlayer.tsx
Token cripto + Redis              src/lib/playTokens.ts
Proxy HLS                         src/app/api/player/proxy/route.ts
Extração de stream                src/app/api/player/extract/route.ts
Autenticação                      src/lib/auth.ts
Proteção SSRF                     src/lib/ssrf.ts
Audit logging                     src/lib/auditLog.ts
Métricas Redis                    src/lib/metrics.ts
Schema de banco                   prisma/schema.prisma
Electron main process             desktop/electron/main.js
Electron IPC bridge               desktop/electron/preload.js
Android WebView bridge            android/app/.../ObaflixBridge.kt
Android extração                  android/app/.../StreamExtractor.kt
Android CDN intercept             android/app/.../PlayerWebViewClient.kt
```
