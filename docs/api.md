# Rotas de API

Todas as rotas são Next.js API Routes em `src/app/api/`.

## Player

### POST /api/player/token

Gera um PlayToken para iniciar uma sessão de reprodução.

**Auth:** sessão válida + rate limit (20 req/min)

**Request body:**
```json
{ "embedUrl": "https://embedplayer2.xyz/v/abc123" }
```

**Response:**
```json
{ "playToken": "base64url.hmac" }
```

**Erros:**
- `401` — não autenticado
- `429` — rate limit atingido
- `403` — IP bloqueado

---

### GET /api/player/extract

Extrai a URL real do stream e retorna um StreamToken opaco.

**Auth:** sessão + PlayToken válido

**Query params:**
- `url` — URL do embed player
- `playToken` — token emitido por `/token`

**Response (stream encontrado):**
```json
{ "tipo": "hls", "streamToken": "iv.enc.tag" }
```

**Response (embed direto / sem stream):**
```json
{ "tipo": "iframe", "stream": "https://embed-url..." }
```

**Erros:**
- `401/403` — auth falhou
- `429` — limite de streams simultâneos (3)
- Timeout 25s → retorna `tipo: "iframe"`

---

### GET /api/player/proxy

Serve o stream HLS proxado e reescreve M3U8.

**Auth:** sessão válida + StreamToken ou SegmentSig

**Query params (modo StreamToken):**
- `t` — stream token opaco

**Query params (modo SegmentSig):**
- `url` — URL do segmento
- `sig` — HMAC do segmento
- `ref` — referer para o CDN (opcional)

**Response:** bytes do M3U8/TS/key; M3U8 tem URLs reescritas.

---

## Progresso

### POST /api/progress

Salva posição de reprodução.

**Auth:** sessão válida

**Request body:**
```json
{
  "conteudoId": "abc",
  "conteudoTipo": "serie",
  "episodioId": "ep123",
  "temporada": 1,
  "numeroEp": 3,
  "progressoSeg": 1423,
  "duracaoSeg": 2856
}
```

`progressoSeg` e `duracaoSeg` são coercidos para Int via `Math.round(Number(...))`.

Quando `progressoSeg > 90% * duracaoSeg`: marca `concluido=true` e pré-enfileira próximo episódio.

**Response:** `{ "ok": true }`

---

### GET /api/progress

Busca posição salva para retomada.

**Query params:** `conteudoId`, `episodioId` (opcional)

**Response:**
```json
{ "progressoSeg": 1423, "concluido": false, "duracaoSeg": 2856 }
```

---

## Conteúdo

### GET /api/filmes

Lista filmes com filtros/paginação.

**Query params:** `page`, `limit`, `genero`, `busca`

### GET /api/filmes/[id]

Detalhes de um filme incluindo gêneros.

### GET /api/series

Lista séries.

### GET /api/series/[id]

Detalhes de uma série.

### GET /api/series/[id]/episodios

Episódios de uma série, agrupados por temporada.

### GET /api/search

**Query params:** `q` — busca em filmes + séries por título.

### GET /api/home

Dados para a home: destaques, lançamentos, categorias. Cacheado.

---

## Usuário

### GET /api/user/continue

Retorna lista "Continuar Assistindo" (WatchHistory com progresso > 0, não concluído, mais recente primeiro).

### GET /api/user/history

Histórico completo do usuário.

### GET /api/user/watchlist

Lista da watchlist do usuário.

### POST /api/user/watchlist

Adiciona item à watchlist.

**Request body:** `{ conteudoId, conteudoTipo }`

### DELETE /api/user/watchlist/[id]

Remove item da watchlist.

### GET /api/user/watchlist/check

Verifica se item está na watchlist.

**Query params:** `conteudoId`, `conteudoTipo`

### POST /api/like

Registra like/dislike.

**Request body:** `{ conteudoId, conteudoTipo, valor: 1 | -1 }`

### GET /api/continuar-assistindo

Alias público para `/api/user/continue` (pode ter cache diferente).

---

## Autenticação

### POST /api/auth/cadastro

Cria nova conta.

**Request body:** `{ nome, email, senha }`

### /api/auth/[...nextauth]

Handler padrão do NextAuth — login, logout, callbacks OAuth.

---

## Admin (requer role="admin" ou x-admin-token)

### GET /api/admin/stats

Estatísticas gerais: total de filmes, séries, usuários, streams ativos.

### GET /api/admin/security-metrics

Métricas de segurança do Redis: tokens usados, IPs bloqueados, rate limits.

### POST /api/admin/import

Importa conteúdo em lote (filmes ou séries) a partir de JSON.

### GET/POST /api/admin/filme

Gerencia filmes (criar, atualizar, deletar).

### GET/POST /api/admin/serie

Gerencia séries.

### GET/POST /api/admin/episodio

Gerencia episódios.

### POST /api/admin/episodio/bulk

Importa múltiplos episódios de uma vez.

### GET /api/admin/tmdb-search

Busca metadata no TMDB por título.

### POST /api/admin/backfill-logos

Busca e preenche logos faltantes via TMDB.

### POST /api/admin/reset-password

Reseta senha de um usuário pelo admin.

---

## Cron

### GET /api/cron/sync

Sincroniza conteúdo com fonte externa. Chamado pelo Vercel Cron (`vercel.json`).

**Auth:** `Authorization: Bearer CRON_SECRET`
