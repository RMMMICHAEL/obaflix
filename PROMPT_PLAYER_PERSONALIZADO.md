# PROMPT: Player Personalizado — Extração de Stream sem Embed

## Objetivo

Criar um player de vídeo **100% personalizado** que extrai o stream real (m3u8/mp4)
das plataformas de embed (luluvdo, playhide, hlswish, listeamed, etc.) e reproduz
**diretamente no nosso player**, sem carregar o iframe da plataforma original.

URL de acesso ao player:
```
http://localhost:3000/player?url=https://luluvdo.com/e/a9brsu53sg5b
```

---

## Contexto do Projeto

Stack: **Next.js 14 (App Router) + TypeScript + TailwindCSS**  
Localização: `D:\streaming-app`

### Arquivos principais a analisar ANTES de implementar:

| Arquivo | O que faz |
|---|---|
| `src/components/player/CustomPlayer.tsx` | Player atual (usa iframe direto) — será substituído |
| `src/app/assistir/filme/[id]/page.tsx` | Página do player de filme |
| `src/app/assistir/serie/[id]/[temp]/[ep]/page.tsx` | Página do player de episódio |
| `src/app/api/progress/route.ts` | API de salvar progresso (manter funcionando) |
| `src/lib/prisma.ts` | Cliente do banco |
| `prisma/schema.prisma` | Schema do banco — ver modelo Filme e Episodio (urlDub, urlLeg) |

### Formato das URLs que temos no banco:
```
urlDub: "https://playhide.shop/v/rp8ngvnylvkn,https://luluvdo.com/e/dwrnbizu9vqr,https://hlswish.com/e/4snzm2atjm1i"
urlLeg: "https://listeamed.net/e/ZMVoErbz6jeE9Pa"
```
São listas separadas por vírgula. Cada item é uma fonte alternativa.

---

## O que precisa ser criado

### 1. API Route: `/api/player/extract`

```
GET /api/player/extract?url=https://luluvdo.com/e/a9brsu53sg5b
```

Responsabilidade: receber a URL de embed, fazer fetch server-side, parsear o HTML/JS
da resposta e retornar a URL real do stream (m3u8 ou mp4).

**Lógica de extração por plataforma:**

```typescript
// Padrões a buscar no HTML/JS da página de embed:

// luluvdo.com
// Buscar: sources:[{"file":"https://...m3u8"}]  ou  file:"https://...m3u8"
// Regex: /sources:\s*\[\s*\{\s*["']?file["']?\s*:\s*["']([^"']+)["']/

// playhide.shop
// Buscar: source src="https://...m3u8"  ou  file:"https://..."
// Regex: /file\s*:\s*["']([^"']+\.m3u8[^"']*)/

// hlswish.com
// Buscar: {file:"https://...m3u8"}
// Regex: /file["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/

// listeamed.net
// Buscar: source:"https://..." ou jwplayer setup
// Regex: /source\s*:\s*["']([^"']+)/

// Fallback geral:
// Regex: /(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/
// Regex: /(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/
```

A API deve:
1. Fazer `fetch(url)` com headers de browser (User-Agent, Referer)
2. Pegar o HTML retornado
3. Tentar os regexes na ordem acima
4. Se não achar direto, procurar por um segundo redirect (alguns embeds redirecionam para outra URL com o stream)
5. Retornar `{ stream: "https://cdn.exemplo.com/video.m3u8", tipo: "hls" | "mp4" }`

### 2. Página: `/player`

```
src/app/player/page.tsx
```

Recebe `?url=` como query param e renderiza o player completo.

### 3. Componente: `<StreamPlayer />`

```
src/components/player/StreamPlayer.tsx
```

Player HLS nativo usando **hls.js** para streams m3u8:

```typescript
// Instalar: npm install hls.js

import Hls from "hls.js";

// Se stream termina em .m3u8 → usar Hls.js
// Se stream termina em .mp4  → usar <video src> direto
// Se Hls.isSupported() → usar Hls.js
// Senão → video.src = streamUrl (Safari tem suporte nativo a HLS)
```

**Funcionalidades do player:**
- Controles nativos do `<video>` + overlay customizado
- Botões: Play/Pause, Volume, Fullscreen, tempo atual / duração
- Seletor de fonte (Fonte 1, Fonte 2...) — testa cada URL da lista separada por vírgula
- Toggle DUB / LEG — troca entre urlDub e urlLeg
- Salva progresso a cada 10s via `POST /api/progress`
- Se stream der erro, tenta automaticamente a próxima fonte
- Botão X para voltar

### 4. Atualizar `CustomPlayer.tsx`

Substituir o iframe atual por uma chamada à API de extração:

```typescript
// Fluxo:
// 1. Recebe urlDub/urlLeg (lista de URLs de embed separadas por vírgula)
// 2. Para a fonte atual, chama GET /api/player/extract?url=<embed_url>
// 3. Recebe { stream, tipo }
// 4. Passa para <StreamPlayer stream={stream} tipo={tipo} />
// 5. Se extract falhar → mostrar botão "Abrir fonte original" (fallback para iframe)
```

---

## Estrutura de arquivos a criar

```
src/
  app/
    player/
      page.tsx                    ← página /player?url=...
    api/
      player/
        extract/
          route.ts                ← GET /api/player/extract?url=
  components/
    player/
      StreamPlayer.tsx            ← player HLS/MP4 com hls.js
      CustomPlayer.tsx            ← atualizar para usar StreamPlayer
```

---

## Exemplo de uso final

Na página do filme (`/assistir/filme/[id]`), o fluxo será:

```
urlDub = "https://luluvdo.com/e/abc,https://hlswish.com/e/xyz"

1. Usuário clica Assistir
2. CustomPlayer pega primeira URL: "https://luluvdo.com/e/abc"
3. Chama /api/player/extract?url=https://luluvdo.com/e/abc
4. API retorna: { stream: "https://cdn-luluvdo.com/hls/abc/index.m3u8", tipo: "hls" }
5. StreamPlayer carrega o m3u8 com hls.js
6. Vídeo toca direto no nosso player, sem iframe, sem anúncios
```

---

## Dependências a instalar

```bash
npm install hls.js
npm install @types/hls.js
```

---

## Headers necessários no fetch da API

```typescript
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Referer": new URL(url).origin,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
};
```

---

## Comportamento esperado de erros

| Situação | Comportamento |
|---|---|
| Extract retorna stream | Toca no StreamPlayer |
| Extract falha (403, não achou regex) | Tenta próxima fonte automaticamente |
| Todas as fontes falharam | Mostra mensagem + botão para abrir embed direto |
| Stream m3u8 dá erro no meio | Tenta próxima fonte |

---

## Observação importante

Alguns servidores bloqueiam fetch server-side via CORS ou checagem de IP.
Nesse caso, a extração pode falhar para algumas plataformas. O fallback para iframe
deve sempre existir como segurança.
