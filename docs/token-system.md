# Sistema de Tokens

## Arquivo

`src/lib/playTokens.ts`

## Três Camadas

```
Usuário clica "Assistir"
        ↓
[PlayToken]   — HMAC-SHA256, TTL 5min
        ↓ (validado em /extract)
[StreamToken] — AES-256-GCM, TTL 20min, uso único
        ↓ (validado em /proxy, primeira requisição)
[SegmentSig]  — HMAC-SHA256 por segmento, inscrito no M3U8 reescrito
```

## PlayToken

Autoriza uma única chamada a `/api/player/extract`.

**Estrutura:**
```typescript
interface PlayTokenPayload {
  uid: string;   // userId
  eh: string;    // SHA-256(embedUrl).slice(0,16) — hash da URL
  ih: string;    // SHA-256(clientIP).slice(0,16) — hash do IP
  exp: number;   // timestamp de expiração (Date.now() + 5min)
  n: string;     // nonce aleatório (8 bytes)
}
```

**Formato no wire:** `base64url(JSON).hmac`

**Verificação:**
- Tenta chave da semana atual e da semana anterior (janela de rotação)
- Valida: expiração, userId, hash da embedUrl
- IP mismatch é tolerado (rede móvel) — auditado mas não rejeitado

## StreamToken

Encapsula a URL real do stream CDN. Nunca exposta diretamente ao browser.

**Estrutura:**
```typescript
interface StreamTokenPayload {
  uid: string;        // userId
  url: string;        // URL real do stream CDN
  ref: string | null; // Referer que o CDN espera
  ih: string;         // hash do IP
  uah: string;        // hash do User-Agent
  exp: number;        // expiração (20min)
  th: string;         // token hash (para sorted set de streams ativos)
}
```

**Cripto:** AES-256-GCM (autenticado). Formato: `base64url(iv).base64url(enc).base64url(tag)`

**Single-use:** ao ser consumido em `/proxy`:
1. `SET NX play:used:<hash>` no Redis — atômico, funciona em múltiplas instâncias serverless
2. Se a chave já existir: token rejeitado (replay attack)

**Concorrência (max 3 streams simultâneos por user):**
```
Redis sorted set: play:streams:<userId>
  score = expiresAt (timestamp)
  member = th (token hash)

Antes de criar novo token:
  ZREMRANGEBYSCORE → remove expirados
  ZCARD → conta ativos
  SE >= 3: rejeita com 429
  SE < 3: ZADD → registra novo stream
```

## SegmentSig

Assina individualmente cada URL de segmento no M3U8 reescrito.

```typescript
function signSegmentUrl(url: string, userId: string): string {
  return HMAC-SHA256(`${userId}:${url}`, key).slice(0, 22); // base64url, 22 chars
}
```

O M3U8 é reescrito pelo proxy para que cada linha de segmento vire:
```
/api/player/proxy?url=<segUrl>&sig=<hmac>&ref=<referer>
```

Verificação em `/proxy` para requests com `?sig=`:
- Tenta chave atual e anterior
- `timingSafeEqual` (previne timing attacks)

## Rotação Semanal de Chave

```typescript
function weekNumber() { return Math.floor(Date.now() / (7 * 24 * 3600 * 1000)); }

function deriveKey(week: number) {
  return SHA-256(`${NEXTAUTH_SECRET}:week:${week}`);
}

function keys() {
  const w = weekNumber();
  return [deriveKey(w), deriveKey(w - 1)];  // [atual, anterior]
}
```

**Janela de transição:** sempre verifica com a chave da semana anterior também. Tokens emitidos no fim de uma semana continuam válidos no início da próxima.

A chave é derivada de `NEXTAUTH_SECRET` — alterar essa variável invalida todos os tokens existentes.

## Redis — Prefixos das Chaves

| Prefixo | Propósito | TTL |
|---------|-----------|-----|
| `play:used:<hash>` | StreamToken single-use | 30min |
| `play:block:<hash>` | IP temporariamente bloqueado | 5min |
| `play:abuse:<hash>` | Contador de tentativas abusivas por IP | 60s |
| `play:rate:<userId>` | Rate limit (20 req/min) | 60s |
| `play:streams:<userId>` | Sorted set de streams simultâneos | TTL do token mais longo + 60s |

## Abuse Detection

```
Cada req inválida → recordAbuseAttempt(ip)
  → INCR play:abuse:<hash>
  → SE count >= 10 em 60s:
      SET play:block:<hash> 1 EX 300s (5 min)
      audit("ip_blocked")
```

Rate limit por userId: `20 req/min` para `/api/player/token`.

## Variáveis de Ambiente Necessárias

| Variável | Propósito |
|----------|-----------|
| `NEXTAUTH_SECRET` | Base para derivação de todas as chaves criptográficas |
| `UPSTASH_REDIS_REST_URL` | URL do Upstash Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Token de autenticação Redis |

## Fallback sem Redis (Dev Local)

Se `UPSTASH_REDIS_REST_URL` não estiver configurado, `getRedis()` retorna um Map in-memory. Funciona para desenvolvimento local, mas:
- Single-use tokens não são single-use em múltiplas instâncias
- Rate limit e bloqueio de IP não funcionam corretamente em ambiente serverless
