# Obaflix — Documentação Técnica

> Documentação completa para desenvolvedores. Leia este índice antes de qualquer outro arquivo.

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Frontend / SSR | Next.js 14 (App Router), React 18, Tailwind CSS |
| Backend | Next.js API Routes, Prisma ORM |
| Banco de dados | PostgreSQL |
| Cache / Estado | Upstash Redis (REST) |
| Autenticação | NextAuth.js (JWT + Credentials + Google OAuth) |
| Player | JW Player 8.19.1 + HLS.js |
| Desktop | Electron 31 + electron-builder (Windows x64) |
| Android | WebView + JavascriptInterface (Kotlin) |
| Metadata | TMDB API |
| CDN worker | Cloudflare Worker (extração rola3/4) |
| Deploy | Vercel (site) · GitHub Releases (Electron/Android) |

## Índice da Documentação

| Arquivo | O que cobre |
|---------|-------------|
| [`architecture.md`](architecture.md) | Visão geral do sistema, diagrama de fluxo completo |
| [`player.md`](player.md) | CustomPlayer: Web, Electron, IPC, JW Player, fontes, áudio |
| [`stream-extraction.md`](stream-extraction.md) | Extratores por provedor (rola3/4, playhide, streamwish…) |
| [`player-native-extraction.md`](player-native-extraction.md) | Extração nativa multi-provider no Electron/Android — qual player usa fluxo nativo vs web, como adicionar um novo |
| [`token-system.md`](token-system.md) | PlayToken, StreamToken, SegmentSig, Redis, limites |
| [`proxy.md`](proxy.md) | Proxy HLS, reescrita de M3U8, segurança |
| [`recovery.md`](recovery.md) | Fallback, renovação de token, auto-avanço, recuperação de erros |
| [`electron.md`](electron.md) | App desktop: IPC, bypass CDN, auto-update |
| [`android.md`](android.md) | App Android: WebView, bridge, extração nativa, diferenças |
| [`auth.md`](auth.md) | Autenticação, sessões, admin, CORS |
| [`database.md`](database.md) | Schema Prisma, modelos, índices |
| [`api.md`](api.md) | Todas as rotas de API |
| [`environment.md`](environment.md) | Variáveis de ambiente, setup local e produção |

## Início Rápido (Desenvolvimento Local)

```bash
# 1. Clonar e instalar
git clone https://github.com/RMMMICHAEL/obaflix.git
cd obaflix
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env.local
# Editar .env.local com DATABASE_URL, NEXTAUTH_SECRET, etc.

# 3. Sincronizar schema do banco
npx prisma db push

# 4. Iniciar servidor de desenvolvimento
npm run dev
# → http://localhost:3000

# 5. (Opcional) Electron desktop
cd desktop && npm install
npm run start   # inicia o app Electron apontando para localhost:3000
```

## Componentes Críticos — Não Altere Sem Ler a Doc

| Componente | Por que é crítico |
|-----------|------------------|
| `src/components/player/CustomPlayer.tsx` | Toda a lógica de player, recovery, token renewal |
| `src/lib/playTokens.ts` | Criptografia, concorrência, abuse detection |
| `src/app/api/player/proxy/route.ts` | Proxy HLS; SSRF e origem validados aqui |
| `desktop/electron/main.js` | IPC bridge, bypass CDN rola3/4 |
| `android/app/.../ObaflixBridge.kt` | Equivalente Android do preload Electron |
| `prisma/schema.prisma` | Schema do banco; migrations requerem cuidado |

## Convenções de Código

- Logs de recovery: sempre via `recoveryLog()` em `CustomPlayer.tsx`
- Filtro de fontes visíveis no site web: `fonte.tokenized` / `isTokenizedUrl()` — só rola3/rola4
- Extração nativa no Electron/Android (independente do filtro acima):
  `supportsNativeDesktopExtraction()` em `CustomPlayer.tsx` — ver
  [`player-native-extraction.md`](player-native-extraction.md) para o mapa completo de
  providers e o passo a passo de como adicionar um novo (sempre 4 arquivos em conjunto:
  `route.ts`, `extractors.js`, `PlayerExtractors.kt`, `CustomPlayer.tsx`)
