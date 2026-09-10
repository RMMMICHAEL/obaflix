# Variáveis de Ambiente

## Configuração

Copiar `.env.example` → `.env.local` para desenvolvimento local:

```bash
cp .env.example .env.local
```

Para produção: configurar no painel do Vercel (Settings → Environment Variables).

## Variáveis Obrigatórias

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `DATABASE_URL` | PostgreSQL via pooler (Supabase PgBouncer) | `postgresql://user:pass@db.supabase.co:6543/postgres?pgbouncer=true` |
| `DIRECT_URL` | PostgreSQL direto, sem pooler (para migrations) | `postgresql://user:pass@db.supabase.co:5432/postgres` |
| `NEXTAUTH_SECRET` | Chave mestra: JWT + tokens criptográficos do player | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | URL base do site (callbacks OAuth) | `https://obaflix.vercel.app` |

**Cuidado com `NEXTAUTH_SECRET`:** alterar esse valor invalida instantaneamente todos os StreamTokens, PlayTokens e SegmentSigs em uso. Em produção, só rotacionar durante manutenção planejada.

## Variáveis Fortemente Recomendadas (Produção)

| Variável | Descrição |
|----------|-----------|
| `UPSTASH_REDIS_REST_URL` | URL do Upstash Redis REST API |
| `UPSTASH_REDIS_REST_TOKEN` | Token de autenticação Upstash |

Sem Redis: rate limit, bloqueio de IP e controle de streams simultâneos usam Map in-memory — não funciona corretamente com múltiplas instâncias serverless no Vercel.

## Variáveis Opcionais

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `GOOGLE_CLIENT_ID` | OAuth Google (login social) | — (desativado se ausente) |
| `GOOGLE_CLIENT_SECRET` | OAuth Google | — |
| `TMDB_API_KEY` | API TMDB para metadata/logos | — (import e backfill quebram sem isso) |
| `ADMIN_SECRET_TOKEN` | Token estático para scripts admin | — |
| `EMBED_WORKER_URL` | URL do Cloudflare Worker (extração rola3/4 na Web) | — (retorna iframe se ausente) |
| `EMBED_WORKER_SECRET` | Secret para autenticar com o Worker | `""` |
| `CRON_SECRET` | Token para autenticar chamadas do Vercel Cron | — |

## Monetização

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `MONETIZACAO_ATIVA` | Enforcement comercial em `POST /api/player/fontes`. **Só a string exata `"true"` liga** | desligado |
| `BLACKCAT_PIX_ATIVO` | Criação real de PIX em `POST /api/billing/orders`. **Só a string exata `"true"` liga** | desligado |
| `BLACKCAT_API_KEY` | Chave administrativa da Blackcat. **Servidor apenas** | — (a rota responde 503 sem ela) |
| `BLACKCAT_API_BASE_URL` | Base alternativa do provedor, só para teste/staging. Precisa ser `https:` | a URL oficial documentada |

**Duas flags, de propósito.** `MONETIZACAO_ATIVA` decide se o enforcement nega
conteúdo; `BLACKCAT_PIX_ATIVO` decide se é possível cobrar. Precisam ser
acionáveis em separado — cobrar antes de restringir é o rollout normal, e
desligar a cobrança durante um incidente do gateway não pode derrubar o acesso de
quem já pagou.

**Só `"true"` liga, nas duas.** `Boolean(process.env.X)` seria o erro clássico:
`Boolean("false")` é `true`, então escrever `=false` para desligar ligaria. A
comparação é estrita, e `"TRUE"`, `"1"` e `" true"` deixam desligado.

**Nenhuma das duas tem versão `NEXT_PUBLIC_`, e não deve passar a ter.** O
cliente não precisa saber se o enforcement está ligado nem qual gateway existe.

**Cuidado com `BLACKCAT_API_KEY`:** nunca no Git, em `NEXT_PUBLIC_`, no
`BuildConfig` do Android, no `preload.js` do Electron, em Kotlin, em log ou em
resposta HTTP. É lida em um lugar só — `src/lib/billing/blackcat.ts` — e só
aparece no header `X-API-Key`. Faltando com `BLACKCAT_PIX_ATIVO=true`, a rota
responde 503 genérico **sem nomear a variável**, sem chamar o provedor e sem
criar pedido: uma mensagem do tipo "API key missing" seria um oráculo de
configuração para quem estivesse sondando.

## Electron

O app Electron não usa `.env` — a única configuração é a URL do site:

```javascript
// desktop/electron/main.js
const OBAFLIX_URL = process.env.OBAFLIX_URL || "https://obaflix.vercel.app";
```

Para apontar o Electron para o dev server: `OBAFLIX_URL=http://localhost:3000 npm start` (no diretório `desktop/`).

## Supabase — Setup

1. Criar projeto em [supabase.com](https://supabase.com)
2. Settings → Database → Connection string:
   - **URI** → `DATABASE_URL` (inclui `?pgbouncer=true&connection_limit=1`)
   - **Direct connection** → `DIRECT_URL`
3. `npx prisma db push` para criar as tabelas

## Upstash Redis — Setup

1. Criar database em [console.upstash.com](https://console.upstash.com)
2. Copiar **REST URL** → `UPSTASH_REDIS_REST_URL`
3. Copiar **REST Token** → `UPSTASH_REDIS_REST_TOKEN`
4. Plano free: 10.000 requests/dia (suficiente para desenvolvimento)

## Cloudflare Worker — Setup

O Worker é necessário para extração de rola3/4 na Web (sem Electron). Localização do código: não está neste repositório.

1. Deploy do Worker no Cloudflare
2. `EMBED_WORKER_URL` = URL do Worker (ex: `https://obaflix-worker.user.workers.dev`)
3. `EMBED_WORKER_SECRET` = secret compartilhado para autenticação

Sem o Worker: `/api/player/extract` para rola3/4 retorna `tipo: "iframe"` (sem extração).
