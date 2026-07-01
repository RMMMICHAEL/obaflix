# Extração de Streams

## Localização

```
src/app/api/player/extract/route.ts   ← Web/API path
desktop/electron/main.js              ← Electron/local server path
```

## Visão Geral

A extração converte uma URL de embed de terceiros em uma URL de stream direta (M3U8 ou MP4). Cada provider tem seu próprio mecanismo de proteção — scraping HTML, API POST, deobfuscação JS.

## Roteamento por Provider

`doExtract(url)` identifica o provider pelo hostname/pathname e chama o extrator apropriado:

| Condição | Provider | Extrator |
|----------|----------|----------|
| `pathname.includes("vast.php")` | Redirect | Recursivo com URL decodificada |
| `hostname.includes("voltz.php")` | Voltz | `extractVoltz()` — scraping HTML |
| `hostname.includes("lulu\|luluvdo")` | Luluvdo | Retorna `tipo: "iframe"` (embed direto) |
| `hostname.includes("hide\|playhide")` | PlayHide | `extractHide()` via moon.php |
| `hostname.includes("wish\|streamwish\|hlswish\|playerwish")` | StreamWish | `extractWish()` — API POST + fallback HTML |
| `pathname.includes("/rola4/\|/rola3/")` ou `embedplayer` | Rola3/4 | Cloudflare Worker URL |
| `hostname.includes("rola\|llanfair")` | Rola1/2 | `extractRola()` — API POST |
| `hostname.includes("bolt")` | Bolt | `extractBolt()` — scraping HTML |
| `hostname.includes("big\|bigshare")` | BigShare | `extractBig()` — scraping HTML |
| (padrão) | Genérico | `moon.php` deobfuscação → `findM3u8()` |

Se nenhum stream for encontrado: retorna `{ tipo: "iframe", stream: url }` — o player renderiza o embed em um iframe.

## Extratores Detalhados

### PlayHide (`extractHide`)

```
GET https://playhide.shop/v/<id>
headers: { Referer: "https://megaflix.lat/" }
  │
  ├── extractEvalScript(html) → trecho eval(function(p,a,c,k,e,d)...)
  │
  └── moon(evalScript) → deobfuscação via moon.php
       │
       └── var links = { hls3: "...", hls2: "...", hls4: "..." }
           → retorna links.hls3 || links.hls2 || links.hls4
```

**Atenção:** o CDN do PlayHide valida `Referer: https://playhide.shop/v/<id>` em todos os requests. O campo `referer` retornado por `doExtract()` é armazenado no StreamToken e enviado pelo proxy ao CDN.

### moon.php — Deobfuscação JS

`moon.php` é um script externo (`app.megafrixapi.com/moon.php`) que recebe um script JS obfuscado (eval/packer) em base64 e retorna o código desobfuscado:

```typescript
async function moon(obfuscatedScript: string): Promise<string> {
  const encoded = Buffer.from(obfuscatedScript).toString("base64");
  const res = await fetch(MOON, {
    method: "POST",
    body: `data=${encodeURIComponent(encoded)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return res.text(); // código JS legível
}
```

`extractEvalScript()` localiza o padrão `eval(function(p,a,c,k,e,d)` no HTML e extrai o chunk completo até `.split('|'),0,{})`.

### StreamWish (`extractWish`)

Três tentativas em cascata:

1. **API POST** — `POST embedUrl { hash: id, r: "", do: "getVideo" }` → `json.sources[0].file`
2. **M3U8 no HTML** — `findM3u8(html)` regex
3. **JW Player literal** — `[{file:"<url>"}]` split / regex
4. **Fallback para `extractHide`** — caso a página use o mesmo packer JS

### Rola3/Rola4 — Cloudflare Worker

Na Web (não-Electron), o extrator retorna a URL do Cloudflare Worker em vez de extrair diretamente:

```typescript
streamUrl = `${workerUrl}/stream?embedUrl=${encodeURIComponent(url)}`;
```

O Worker executa fora do Vercel e tem seu próprio IP público — contorna a restrição de IP-bound token para a extração inicial. **Porém, o CDN ainda valida IP do usuário nos requests de segmento** — por isso, no Electron, o bypass CDN é necessário. Na Web, essa rota resulta em CDN servindo para o IP do Vercel, o que só funciona se o token não for estritamente IP-bound nos segmentos.

No Electron: `onBeforeRequest` redireciona `/api/player/extract` para o servidor local. O Worker URL não é usado.

### Genérico (fallback)

```typescript
const html = await fetchHtml(url, "https://megaflix.lat/");
const evalScript = extractEvalScript(html);
if (evalScript) {
  const decoded = await moon(evalScript);
  streamUrl = findM3u8(decoded) || decoded.split('[{file:"')[1]?.split('"')[0];
}
if (!streamUrl) streamUrl = findM3u8(html);
```

## fetchHtml

Impersona um browser Chrome com headers corretos para evitar bloqueio por bot detection:

```typescript
headers: {
  "User-Agent": "Mozilla/5.0 Chrome/122.0.0.0",
  "Referer": referer || origin + "/",
  "Sec-Fetch-Dest": "iframe",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
}
```

O `Referer` padrão é `https://megaflix.lat/` — simula o usuário vindo do site do Megaflix, que é o referrer esperado pelos providers.

## findM3u8

Regex ordenada por especificidade:

```typescript
const patterns = [
  /["'](https?:\/\/[^"']+\.m3u8[^"']*)/i,   // URL .m3u8 em aspas
  /file:\s*["'](https?:\/\/[^"']+)/i,         // file: "url"
  /source:\s*["'](https?:\/\/[^"']+)/i,       // source: "url"
];
```

## Timeout e Fallback

```typescript
const result = await Promise.race([
  doExtract(url),
  new Promise((resolve) =>
    setTimeout(() => resolve({ stream: url, tipo: "iframe" }), 25000)
  ),
]);
```

Se a extração demorar mais de 25s: retorna `tipo: "iframe"` (player tenta embed direto).

## Segurança

Antes de qualquer fetch: `assertSafeUrl(url)` do `src/lib/ssrf.ts` — valida que a URL não aponta para rede interna (SSRF). Bloqueia: `127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`.

Após extração: stream URL também passa por `assertSafeUrl` no proxy antes de ser fetched.

## Electron — extractSecuredLink

Equivalente local ao extrator Web para rola3/4. Opera com o IP do usuário:

```javascript
const apiUrl = `${base}/player/index.php?data=${id}&do=getVideo`;
const res = await fetch(apiUrl, {
  headers: {
    "X-Requested-With": "XMLHttpRequest",
    "Referer": embedUrl,
    "Origin": base,
  },
  body: `hash=${id}&r=${OBAFLIX_URL}/`,
});
// retorna { stream: securedLink, embedOrigin: base }
```

Após sucesso: `playerState.cdnHostname` e `playerState.embedReferer` são atualizados para que `onBeforeSendHeaders` injete o Referer correto nos requests CDN.
