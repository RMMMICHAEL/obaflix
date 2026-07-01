# Player — CustomPlayer.tsx

## Localização

`src/components/player/CustomPlayer.tsx`

Este é o componente mais crítico do projeto. Qualquer alteração aqui pode quebrar a reprodução em Web, Electron e Android simultaneamente.

## Props

```typescript
interface Props {
  urlDub: string | null;          // URLs embed (Dub), separadas por vírgula
  urlLeg: string | null;          // URLs embed (Leg), separadas por vírgula
  titulo: string;                 // Título do conteúdo
  thumbUrl?: string;              // Thumbnail para poster do player
  conteudoId: string;             // ID do conteúdo (FK para Filme/Serie)
  conteudoTipo: "filme" | "serie";
  episodioId?: string;            // ID do episódio (para séries)
  temporada?: number;
  numeroEp?: number;
  prevUrl?: string;               // URL do episódio anterior
  nextUrl?: string;               // URL do próximo episódio (auto-avanço)
  duracaoSeg?: number;            // Duração em segundos (fallback se JW não retornar)
  initialProgressoSeg?: number;   // Posição inicial (retomada de progresso)
}
```

## Interface Fonte

```typescript
interface Fonte {
  label: string;       // Ex: "[Dub] 1", "[Leg] 2"
  embedUrl: string;    // URL do embed player
  tokenized: boolean;  // true = rola3/4; suporta token renewal
}
```

`tokenized` é definido em `parseFontes()` via `isTokenizedUrl()`. **Nunca use o nome do domínio diretamente no error handler** — use sempre `fonte.tokenized`.

Para adicionar um novo provider tokenizado: adicionar pattern em `isTokenizedUrl()`.

## Ciclo de Vida

```
mount
  │
  ├── parseFontes(urlDub) + parseFontes(urlLeg) → allFontes[]
  │   (rola3/4 incluídos apenas em Electron/Android: isDesktop = true)
  │
  ├── GET /api/player/token
  │
  └── useEffect([episodioId, fonteIdx])
       │
       ├── GET /api/player/extract (com playToken)
       │   ├── se tokenized + desktop: extractStream via IPC/Bridge
       │   └── senão: fetch /api/player/extract (Vercel proxy path)
       │
       ├── JW Player setup()
       │   ├── player.on("firstFrame") → initialLoadRef = false
       │   ├── player.on("play")       → initialLoadRef = false (fallback)
       │   ├── player.on("time")       → atualiza progressoRef + durationRef
       │   ├── player.on("complete")   → auto-avanço para nextUrl
       │   ├── player.on("error")      → error handler (ver recovery.md)
       │   └── player.on("warning")    → [DIAG] log (remover após debug)
       │
       └── return cleanup: player.remove(), clearTimers()
```

## initialLoadRef — Ciclo de Vida do Player

Este ref é crítico para distinguir falha de carga inicial de expiração de token mid-stream.

```
mount / switchFonte()
  │
  └── initialLoadRef.current = true
        │
        ├── JW Player carregando...
        │   │
        │   ├── SE firstFrame dispara → initialLoadRef.current = false  ✓
        │   │   (frame válido exibido; erros agora = token expiry)
        │   │
        │   ├── SE play dispara (sem firstFrame) → initialLoadRef.current = false
        │   │   (fallback para providers que não disparam firstFrame)
        │   │
        │   └── SE error dispara com initialLoadRef=true
        │       → initial-load-fallback (fonte inválida, não token)
        │       → switchFonte(fi + 1) sem runReExtract
        │
        └── Reprodução normal:
            erros → token-renewal (runReExtract) ou cooldown-fallback
```

## suppressErrorUntilRef

Após `jwRef.current.load([...])`, hls.js pode emitir eventos `error` residuais da instância anterior nos próximos ~2 segundos. Este ref suprime esses ecos.

```typescript
suppressErrorUntilRef.current = Date.now() + 2000;
jwRef.current.load([{ file: newUrl, type: "hls" }]);
```

## Extração no Electron (path tokenizado)

```typescript
if (desktop && fonte?.tokenized) {
  // IPC → main.js → Node.js fetch com IP do usuário
  const data = await desktop.extractStream(embedUrl);
  // data = { stream: "https://cdn.../master.m3u8", tipo: "hls", referer: embedUrl }
  
  playerUrl = buildElectronProxyUrl(data.stream, data.referer);
  // → /api/player/proxy?url=<cdnUrl>&native=1&ref=<referer>
  // "native=1" sinaliza para main.js redirecionar direto ao CDN
}
```

## buildElectronProxyUrl

```typescript
function buildElectronProxyUrl(cdnUrl: string, referer?: string | null) {
  const ref = referer ? `&ref=${encodeURIComponent(referer)}` : "";
  return `/api/player/proxy?url=${encodeURIComponent(cdnUrl)}&native=1${ref}`;
}
```

O parâmetro `native=1` é detectado pelo `main.js` do Electron (e pelo `PlayerWebViewClient.kt` do Android) para redirecionar diretamente ao CDN, bypassando o proxy Vercel.

## Faixas de Áudio

O player detecta automaticamente múltiplas faixas de áudio no HLS (DUB/LEG) e expõe um seletor. A faixa escolhida manualmente é preservada via `userAudioTrackRef`.

```typescript
player.on("audioTracks", (e) => {
  if (e.tracks.length > 1) setAudioTracks(e.tracks);
  if (userAudioTrackRef.current !== null) {
    safeSetAudioTrack(userAudioTrackRef.current);  // restaura escolha manual
  } else {
    // auto: seleciona DUB se disponível
  }
});
```

`safeSetAudioTrack()` previne recursão infinita:
`setCurrentAudioTrack()` → `audioTracks` event → `setCurrentAudioTrack()` → ...
via `isChangingAudioTrackRef` flag.

## Auto-Avanço de Episódio

```typescript
player.on("complete", () => {
  if (nextUrl) router.push(nextUrl);
});
```

O `router.push(nextUrl)` navega para a página do próximo episódio.
A página tem `key={episodio.id}` no Server Component, garantindo remount completo do CustomPlayer.
Todos os refs começam do zero para o novo episódio.

## Salvamento de Progresso

```typescript
const saveProgress = useCallback(async () => {
  if (!progressoRef.current) return;
  await fetch("/api/progress", {
    method: "POST",
    body: JSON.stringify({
      conteudoId, conteudoTipo, episodioId, temporada, numeroEp,
      progressoSeg: progressoRef.current,     // Math.floor (sempre Int)
      duracaoSeg: Math.round(durationRef.current || 0) || duracaoSeg,
    }),
  });
}, [...]);
```

**Cuidado:** `durationRef.current` é float (vem do JW Player). `Math.round()` é essencial — o schema Prisma exige `Int?`.

`saveProgress` é chamado:
- A cada 5 segundos durante reprodução
- No evento `complete`
- No `beforeunload`

## Refs Críticos

| Ref | Tipo | Propósito |
|-----|------|-----------|
| `jwRef` | `JWPlayer \| null` | Instância do player atual |
| `progressoRef` | `number` | Posição atual em segundos (Int) |
| `durationRef` | `number` | Duração em segundos (arredondado) |
| `initialLoadRef` | `boolean` | true = nenhum frame exibido ainda |
| `suppressErrorUntilRef` | `number` | Timestamp até quando suprimir errors |
| `reExtractCountRef` | `number` | Tentativas de renovação consecutivas |
| `reExtractingRef` | `boolean` | Lock para evitar renovações paralelas |
| `reExtractGenerationRef` | `number` | Geração monotônica para descartar respostas obsoletas |
| `reExtractDebounceRef` | `timeout \| null` | Debounce da renovação |
| `lastReExtractSuccessAtRef` | `number` | Timestamp da última renovação bem-sucedida |
| `lastLoadAtRef` | `number` | [DIAG] Timestamp do load() |
| `unmountedRef` | `boolean` | Sinaliza que o componente foi desmontado |
| `switchFonteRef` | `function` | Ref para `switchFonte` (closures sem stale ref) |
| `saveProgressRef` | `function` | Ref para `saveProgress` |
| `userAudioTrackRef` | `number \| null` | Faixa de áudio escolhida manualmente |
| `isChangingAudioTrackRef` | `boolean` | Lock anti-recursão de audioTracks |

## Constantes

```typescript
const REEXTRACT_MAX_CONSECUTIVE_FAILURES = 3;  // max tentativas token renewal
const REEXTRACT_BASE_DELAY_MS = 500;            // backoff base
const REEXTRACT_MAX_DELAY_MS = 8000;            // backoff máximo
const REEXTRACT_MIN_COOLDOWN_MS = 5000;         // cooldown após renovação
const REEXTRACT_SAFETY_TIMEOUT_MS = 15000;      // timeout IPC extractStream
```

## Logs de Recovery

Todos os eventos de recovery usam `recoveryLog()`:

```
[recovery]  reason=<R>  gen=<G>  attempt=<A>  fi=<F>/<LEN-1>  pos=<P>s  sinceRenewal=<S>  → <detail>
```

| Campo | Significado |
|-------|-------------|
| `reason` | `initial-load-fallback`, `cooldown-fallback`, `token-renewal`, `token-renewal-success`, `token-renewal-failed`, `token-renewal-discarded`, `source-switch`, `suppressed` |
| `gen` | Geração da renovação (previne race conditions) |
| `attempt` | Número da tentativa consecutiva |
| `fi/len` | Índice da fonte atual / total de fontes |
| `pos` | Posição de reprodução em segundos |
| `sinceRenewal` | ms desde a última renovação (ou "never") |
