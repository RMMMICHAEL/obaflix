# Obaflix Embed Proxy — Histórico de Mudanças

## Problema original

O obaflix rodava no Vercel (IPs de datacenter AWS/GCP). Os players **rola3** e **rola4**
(`embedplayer2.xyz`, `xn--*.com`) bloqueiam IPs de datacenter e usam tokens `securedLink`
com vinculação de IP: o IP que extrai o token deve ser o mesmo que baixa os segmentos HLS.
Resultado: extração no Vercel → 403 nos segmentos.

---

## Solução: Cloudflare Worker como proxy

**Arquitetura final:**

```
Browser → GET /api/player/extract (Vercel)
        → Vercel detecta rola3/rola4 → retorna Worker /stream URL
        → Browser → GET /stream?embedUrl=... (Cloudflare Worker)
                  → Worker extrai securedLink (mesmo PoP/IP)
                  → Worker busca master.m3u8 (mesmo PoP/IP)
                  → Reescreve todas as URLs para /proxy?u=...
        → Browser → GET /proxy?u=VARIANT_PLAYLIST (Cloudflare Worker)
                  → Worker busca playlist (mesmo PoP/IP)
                  → Detecta M3U8 por conteúdo, reescreve segmentos
        → Browser → GET /proxy?u=SEGMENT (Cloudflare Worker)
                  → Worker busca segmento (mesmo PoP/IP)
                  → CDN valida IP → aceita → stream flui
```

O browser sempre chama o Worker diretamente (não via Vercel), garantindo que extração
e segmentos saiam do **mesmo PoP Cloudflare** e portanto do **mesmo IP de saída**.

---

## Arquivos criados/modificados

### `cloudflare-worker/worker.js`
Worker Cloudflare com dois endpoints:

| Endpoint | Descrição |
|---|---|
| `GET /stream?embedUrl=URL` | Extrai securedLink + busca master.m3u8 em um único request |
| `GET /proxy?u=URL&ref=URL` | Proxia qualquer URL (M3U8, .ts, chaves AES) |

### `cloudflare-worker/wrangler.toml`
Configuração de deploy. Variáveis:
- `ALLOWED_ORIGIN`: domínio do obaflix para CORS
- `WORKER_SECRET`: secret para o endpoint POST (legado, não usado no fluxo atual)

### `src/app/api/player/extract/route.ts`
Para URLs rola3/rola4, o Vercel não extrai mais diretamente. Retorna:
```json
{ "stream": "https://obaflix-proxy.obavercel.workers.dev/stream?embedUrl=ENCODED", "tipo": "hls" }
```

---

## Variáveis de ambiente (Vercel)

| Variável | Valor |
|---|---|
| `EMBED_WORKER_URL` | `https://obaflix-proxy.obavercel.workers.dev` |
| `EMBED_WORKER_SECRET` | (secret configurado no wrangler) |

---

## Problemas encontrados e resoluções

### 1. IP-bound securedLink → 403 nos segmentos
**Causa:** Extração chamada pelo Vercel (US) e proxy chamado pelo browser (BR) → PoPs Cloudflare diferentes → IPs diferentes.  
**Fix:** Browser chama `/stream` diretamente. Extração e primeiro fetch do M3U8 acontecem no mesmo request → mesmo PoP → mesmo IP de saída.

### 2. CDN retorna `video/mp2t` para playlists M3U8
**Causa:** O `embedplayer2.xyz` serve playlists variantes em paths `/hls/BASE64` com `Content-Type: video/mp2t`. O Worker tratava como binário e não reescrevia as URLs.  
**Fix:** Detecção por conteúdo — lê os primeiros bytes e verifica `#EXTM3U`. Segmentos `.ts` nunca começam com `#EXT`, então é discriminador perfeito.

### 3. `#EXT-X-KEY` e `#EXT-X-MAP` não reescritos
**Causa:** O rewriter ignorava todas as linhas começando com `#`, mas essas tags têm atributo `URI="..."` com URL de chave AES.  
**Fix:** Regex `/^#EXT-X-(KEY|MAP|MEDIA|SESSION-KEY)/` identifica essas tags e reescreve apenas o atributo `URI`.

### 4. URLs relativas resolvidas contra URL pré-redirect
**Causa:** Se o CDN redireciona `/hls/BASE64` para outro host, a base para resolver URLs relativas dos segmentos ficava errada.  
**Fix:** Usa `res.url` (URL final após redirects) como base para `rewriteM3u8`.

### 5. Cache do browser servindo versão antiga (binário)
**Causa:** Worker anterior usava `Cache-Control: public, max-age=3600` nas respostas binárias. O Chrome cacheou as playlists variantes não-reescritas.  
**Fix:** Todas as respostas do Worker usam `Cache-Control: no-store`.

### 6. Injeção de ad-tracking no M3U8 (dahds*.xyz)
**Causa:** O `embedplayer2.xyz` injeta URLs de tracking (`dahds11.xyz`, `dahds13.xyz`, etc.) como linhas de "segmento" no M3U8 variante. O servidor de ads retorna 500, quebrando o HLS.js.  
**Fix (duplo):**
- **rewriteM3u8:** filtra segmentos de domínio diferente do CDN de vídeo antes de reescrever. Robusto contra mudança de extensão (`.js`, `.woff`, `.woff2`, etc.).
- **handleProxy:** qualquer resposta 5xx do CDN vira 204 (vazio). HLS.js pula o "segmento" sem abortar.

---

## Deploy

```powershell
cd D:\streaming-app\cloudflare-worker
nvm use 22.23.1        # Node 22+ obrigatório para o wrangler 4.x
npx wrangler login     # autenticar no Cloudflare (uma vez)
npx wrangler deploy    # publica em obaflix-proxy.obavercel.workers.dev
npx wrangler secret put WORKER_SECRET  # define o secret
```

## Monitoramento de logs

```powershell
cd D:\streaming-app\cloudflare-worker
npx wrangler tail --format pretty
# ou para salvar em arquivo:
npx wrangler tail --format json 2>&1 | Tee-Object -FilePath "tail.log"
```

Logs esperados em reprodução normal:
```
[STREAM] securedLink=https://embedplayer2.xyz/cdn/hls/.../master.m3u8?md5=...
[PROXY] detected M3U8 finalUrl=https://embedplayer2.xyz/hls/...
[REWRITE] filtered cross-domain segment: https://dahds13.xyz/p/...
[PROXY] binary segment cl=...
```
