# Proxy HLS

## Arquivo

`src/app/api/player/proxy/route.ts`

## Propósito

O proxy serve como intermediário entre o JW Player (browser) e o CDN do provider. Necessário porque:

1. Os CDNs exigem `Referer`, `Origin` e `User-Agent` específicos — o browser não pode injetar esses headers livremente
2. Os tokens de stream devem ser opacos ao browser (não podem ser URLs CDN diretas)
3. A reescrita de M3U8 é necessária para rotear segmentos pelo proxy e assinar cada URL

## Dois Modos de Operação

### Modo 1 — StreamToken (primeira requisição)

```
GET /api/player/proxy?t=<streamToken>
  │
  └── resolveStreamToken(token, userId, ip, ua)
       ├── SET NX play:used:<hash> → se já existe: rejeita
       ├── AES-256-GCM decrypt
       ├── valida: userId, UA hash, expiração
       └── retorna { streamUrl, referer, ipMismatch? }
```

Após resolução: fetcha `streamUrl` com headers corretos e retorna o M3U8 reescrito.

### Modo 2 — SegmentSig (segmentos subsequentes)

```
GET /api/player/proxy?url=<segUrl>&sig=<hmac>&ref=<referer>
  │
  └── verifySegmentUrl(url, userId, sig)
       ├── HMAC-SHA256(userId + url) com chave atual e anterior
       └── timingSafeEqual
```

Após verificação: fetcha `segUrl` com `Referer` injetado e retorna os bytes do segmento.

## Reescrita do M3U8

O M3U8 retornado pelo CDN é reescrito linha a linha:

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.../key.bin"
                              ↓ reescrito
#EXT-X-KEY:METHOD=AES-128,URI="/api/player/proxy?url=<key>&sig=<hmac>&ref=<ref>"

#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"
                             ↓ reescrito
#EXT-X-MEDIA:TYPE=AUDIO,URI="/api/player/proxy?url=<abs>&sig=<hmac>&ref=<ref>"

https://cdn.../seg001.ts
↓ reescrito
/api/player/proxy?url=<absUrl>&sig=<hmac>&ref=<ref>
```

**Regras de reescrita:**
- `#EXT-X-KEY` e `#EXT-X-SESSION-KEY` → reescreve atributo `URI=`
- `#EXT-X-MEDIA` → reescreve atributo `URI=`
- Linhas não-comentário (segmentos) → reescreve toda a linha
- Demais `#`-tags → passthrough sem modificação

**Problema conhecido:** `#EXT-X-MEDIA` pode referenciar font/CSS em alguns M3U8 malformados. Ver TODO em `proxy/route.ts`.

## Headers Injetados no Fetch CDN

```typescript
const headers = {
  "User-Agent": "Mozilla/5.0 Chrome/122.0.0.0",
  "Referer": ref || parsed.origin + "/",
  "Origin": spoofedOrigin,  // origem do embed (cross-site quando diferente do CDN)
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "cross-site" | "same-origin",
  "Accept": "*/*",
  "Sec-GPC": "1",
};
```

O `ref` vem do StreamToken (campo `referer` armazenado durante a extração).

## Segurança

### SSRF

`assertSafeUrl(url)` em `src/lib/ssrf.ts` antes de qualquer fetch:
- Resolve DNS para validar que o hostname não aponta para rede interna
- Bloqueia: `127.0.0.1`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`
- Lança exceção se a URL for interna

### Origin e Referer

```typescript
const origin = req.headers.get("origin");
if (origin && host && !origin.includes(host)) { recordAbuseAttempt; return 403; }

const refererHeader = req.headers.get("referer");
if (refererHeader && host && !refererHeader.includes(host)) { recordAbuseAttempt; return 403; }
```

Rejeita requisições de outros domínios. Ausência de Origin é permitida (browsers omitem em navegação direta e em requests de segmentos HLS).

### Autenticação

Todo request ao proxy exige sessão NextAuth válida (`getServerSession`). Sem sessão: 401.

## Cache

- M3U8 reescrito: `Cache-Control: no-store` (sempre busca fresco)
- Segmentos TS: `Cache-Control: public, max-age=3600` (1 hora de cache)
- Chaves de criptografia (`#EXT-X-KEY`): `Cache-Control: no-store`

## Range Requests

```typescript
const rangeHeader = req.headers.get("range");
if (rangeHeader) headers["Range"] = rangeHeader;
```

Encaminha requests de range para o CDN — necessário para MP4 com seeking.

## Electron — Bypass do Proxy

Para rola3/4, o `main.js` intercepta `/api/player/proxy?url=...&native=1` e redireciona diretamente para a URL CDN, sem passar pelo proxy Vercel:

```javascript
// onBeforeRequest em main.js
if (url.pathname === "/api/player/proxy") {
  const cdnUrl = url.searchParams.get("url");
  const isNative = url.searchParams.get("native") === "1";
  const hasSig = url.searchParams.has("sig");
  if (cdnUrl && !hasSig && isNative) {
    callback({ redirectURL: cdnUrl }); // direto ao CDN
    return;
  }
}
```

URLs com `sig=` (segmentos reescritos pelo proxy) **nunca** são bypassadas — o token deles está vinculado ao IP do Vercel.
