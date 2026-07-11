# Player Webcine (webcinevs2.com)

## O que é

Player 2 na lista de fontes. Usa a API da webcinevs2.com para servir séries e filmes em MP4 direto do CDN `play-amz.playtxs.com` (Cloudflare), sem HLS.

## Pipeline de extração

```
1. POST /api/auth/refresh  →  JWT (30 dias)
2. GET  /api/search?q={titulo}  →  candidatos (id, title)
3. GET  /api/series/{id}?profile_id=...  →  verifica tmdb_id, lista episódios
4. GET  /api/streaming/episodes/{episodeId}/videos?...  →  lista de videos
5. GET  /api/streaming/episodes/{episodeId}/video/{videoId}?device_id=...  →  {video_url (encriptado), session_id}
6. POST /api/streaming/resolve-url  {payload, session_id, device_id}  →  URL com cnvs_token
7. HEAD server-amz.playtxs.com/...  →  302 → play-amz.playtxs.com/...?cnvs_token={ts}-{hmac}
```

## Arquivos modificados

| Arquivo | Mudança |
|---------|---------|
| `src/app/api/player/extract/route.ts` | `extractWebcine()` + case no router `doExtract` |
| `src/components/player/CustomPlayer.tsx` | Adiciona "Player 2" na lista de fontes |
| `.env` / `.env.example` | `WEBCINE_REFRESH_TOKEN`, `WEBCINE_DEVICE_ID`, `WEBCINE_PROFILE_ID` |

## Variáveis de ambiente

```
WEBCINE_REFRESH_TOKEN   # JWT refresh (expira ~40 dias — extraído do localStorage webcinevs2.com)
WEBCINE_DEVICE_ID       # UUID do device registrado (x-device-id header)
WEBCINE_PROFILE_ID      # ID numérico do perfil webcinevs2.com
```

### Renovação do refresh token

O refresh token tem TTL ~40 dias. Quando expirar:
1. Acesse webcinevs2.com no Chrome
2. DevTools → Application → Local Storage → `https://webcinevs2.com`
3. Copie o valor de `refreshToken`
4. Atualize `WEBCINE_REFRESH_TOKEN` no Vercel

O access token (30 dias) é renovado automaticamente pelo extractor via cache em memória (`webcineTokenCache`).

## Autenticação

- Requer Bearer JWT + `x-device-id` em todas as chamadas
- Endpoints públicos (sem auth): `/api/search`, `/api/series/{id}`
- Endpoints autenticados: `/api/streaming/**`, `/api/auth/me`
- `/api/streaming/episodes/{id}/videos` também requer `profile_id` como query param
- `/api/streaming/episodes/{id}/video/{videoId}` também requer `device_id` como query param

## CDN final

- URL: `https://play-amz.playtxs.com/{Titulo}_{tmdbId}.mp4?cnvs_token={ts}-{hmac}&vid={videoId}&pid={profileId}&t={ts}`
- Format: MP4 direto (não HLS) — `Content-Type: video/mp4`, `Accept-Ranges: bytes`
- `cnvs_token` format: `{unix_timestamp}-{base64_hmac}` — válido por tempo determinado
- Sem IP binding detectado (diferente do PlayerFlix CDN)

## Debugging

Logs no Vercel com prefixo `[extract/webcine/*]`:
- `webcine/start` — início da extração
- `webcine/found` — série encontrada com internalId e episodeId
- `webcine/not_found` — TMDB ID não encontrado na busca
- `webcine/video_sel` — video selecionado (audio_type, videoId)
- `webcine/ok` — URL final resolvida com sucesso
- `webcine/error` — erro fatal com mensagem
- `webcine/no_sub` — usuário sem assinatura ativa
