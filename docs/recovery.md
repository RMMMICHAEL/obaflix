# Recovery — Fallback e Renovação de Token

## Visão Geral

O sistema de recovery gerencia o que acontece quando o player encontra um erro de reprodução. A hierarquia define claramente o que fazer em cada situação.

## Hierarquia de Decisão

```
player.on("error")
  │
  ├── 1. SUPRIMIDO: Date.now() < suppressErrorUntilRef.current
  │   └── reason=suppressed → ignora (eco de mídia antiga após load())
  │
  ├── 2. INITIAL-LOAD-FALLBACK: initialLoadRef.current === true
  │   └── reason=initial-load-fallback → switchFonte(fi+1) sem reextração
  │       (fonte inválida ou não disponível; nenhum frame foi exibido)
  │
  ├── 3. SE fonte.tokenized && inElectron && tentativas < REEXTRACT_MAX:
  │   │
  │   ├── 3a. COOLDOWN-FALLBACK: sinceRenewal < REEXTRACT_MIN_COOLDOWN_MS
  │   │   └── reason=cooldown-fallback → switchFonte (renovação muito recente)
  │   │
  │   └── 3b. TOKEN-RENEWAL: schedula runReExtract via debounce
  │       └── reason=token-renewal → runReExtract(embedUrl, fi, len)
  │
  └── 4. SOURCE-SWITCH (fallback final)
      └── reason=source-switch → switchFonte(fi+1) ou setError("Erro no stream")
```

## recoveryLog — Formato de Log

Todos os eventos usam `recoveryLog()` com formato padronizado:

```
[recovery]  reason=X  gen=Y  attempt=Z  fi=A/B  pos=Cs  sinceRenewal=Dms  → <detail>
```

| Campo | Valores | Descrição |
|-------|---------|-----------|
| `reason` | ver tabela abaixo | Motivo do evento |
| `gen` | número ou `-` | Geração da renovação (anti-race condition) |
| `attempt` | número ou `-` | Tentativa consecutiva de renovação |
| `fi/B` | ex: `0/3` | Índice fonte atual / total-1 |
| `pos` | segundos | Posição de reprodução |
| `sinceRenewal` | ms ou `never` | Tempo desde última renovação bem-sucedida |

### Reasons

| Reason | Nível | Significado |
|--------|-------|-------------|
| `suppressed` | log | Erro suprimido (eco pós-load) |
| `initial-load-fallback` | log | Nenhum frame exibido; fonte inválida |
| `cooldown-fallback` | warn | Renovação muito recente; troca de fonte |
| `token-renewal` | log | Iniciando renovação de token (debounce) |
| `token-renewal-success` | log | Stream renovado; load() + seek() executados |
| `token-renewal-failed` | warn | Renovação falhou; troca de fonte |
| `token-renewal-discarded` | log | Resposta descartada (player/geração mudou) |
| `source-switch` | log | Troca de fonte normal (non-tokenized ou max-retries) |

## runReExtract — Fluxo Detalhado

```
runReExtract(embedUrl, fi, len)
  │
  ├── reExtractingRef.current = true (lock)
  ├── reExtractCountRef.current += 1
  ├── myGeneration = ++reExtractGenerationRef.current
  │
  ├── settles = false (garantia de execução única entre .then/.catch/safety)
  ├── safetyTimer = setTimeout(REEXTRACT_SAFETY_TIMEOUT_MS=15s)
  │   → se disparar: settled=true, fail("timeout")
  │
  └── desktop.extractStream(embedUrl)
       │
       ├── .then(data)
       │   ├── SE geração/player mudou → discard (token-renewal-discarded)
       │   ├── SE !data.stream → fail(data.error || "stream vazio")
       │   └── SE ok:
       │       ├── suppressErrorUntilRef = now + 2000
       │       ├── lastReExtractSuccessAtRef = now
       │       ├── jwRef.current.load([{ file: newUrl, type: "hls" }])
       │       ├── SE pos > 5s: após firstFrame → seek(pos) se pos < dur
       │       └── jwRef.current.play()
       │
       ├── .catch(err) → fail("erro inesperado: " + err.message)
       │
       └── .finally() → reExtractingRef.current = false (unlock)
```

## Geração e Race Conditions

`reExtractGenerationRef` é incrementado a cada nova chamada de `runReExtract`. Se o player foi trocado (switchFonte) ou desmontado durante a extração, a resposta é descartada:

```typescript
if (reExtractGenerationRef.current !== myGeneration || jwRef.current !== playerAtStart) {
  // discard — player ou geração mudou
  return;
}
```

## Backoff Exponencial

```typescript
function getReExtractDelay() {
  const attempt = reExtractCountRef.current;
  const delay = Math.min(REEXTRACT_BASE_DELAY_MS * Math.pow(2, attempt - 1), REEXTRACT_MAX_DELAY_MS);
  return delay + Math.random() * 200; // jitter
}
// attempt=1 → ~500ms, attempt=2 → ~1000ms, attempt=3 → ~2000ms (max 8000ms)
```

## switchFonte

Chamada sempre que uma fonte precisa ser trocada:

```typescript
function switchFonte(newFi: number) {
  initialLoadRef.current = true;       // reset: próxima fonte ainda não exibiu frame
  reExtractCountRef.current = 0;       // reset contador de tentativas
  lastReExtractSuccessAtRef.current = 0;
  setFonteIdx(newFi);                  // dispara useEffect → novo JW Player setup
}
```

Quando `newFi >= allFontes.length`: exibe tela de erro ("Erro no stream").

## initialLoadRef — Semântica Detalhada

| Estado | `initialLoadRef.current` | Significado |
|--------|-------------------------|-------------|
| Após mount ou switchFonte | `true` | Aguardando primeiro frame |
| Após `firstFrame` event | `false` | Reprodução ativa; erros = token expiry |
| Após `play` event (fallback) | `false` | Idem |

**Por que `play` como fallback:** alguns providers não disparam `firstFrame` (ex: MP4 direto). `play` garante que `initialLoadRef` seja setado para `false` mesmo nesses casos.

## suppressErrorUntilRef

Ao chamar `jwRef.current.load([...])`, o hls.js pode emitir eventos `error` residuais da instância de HLS anterior por até ~2 segundos. Este timestamp suprime esses erros:

```typescript
suppressErrorUntilRef.current = Date.now() + 2000;
jwRef.current.load([{ file: newUrl, type: "hls" }]);
```

## Auto-Avanço de Episódio

```
player.on("complete")
  → saveProgress() com concluido=true
  → router.push(nextUrl)   // navega para próximo episódio

/api/progress POST com concluido=true
  → cria WatchHistory do próximo episódio com queued=true
  (pré-enfileira na lista "Continuar Assistindo")
```

O Server Component da página do episódio usa `key={episodio.id}`, forçando remount completo do CustomPlayer no novo episódio.

## Providers que Suportam Token Renewal

Apenas fontes com `fonte.tokenized === true` entram no fluxo de `runReExtract`. O campo é definido em `parseFontes()` via `isTokenizedUrl()`:

```typescript
function isTokenizedUrl(url: string) {
  return /\/(rola3|rola4)\//.test(url)
    || /embedplayer/.test(url)
    || /xn--kcksk7a2bl5le7b6doc1h3f/.test(url);
}
```

Para adicionar um novo provider tokenizado: acrescentar pattern nesta função.

Providers **sem** token renewal (source-switch direto): playhide, streamwish, luluvdo, bolt, big, warez2, voltz e qualquer outro não listado em `isTokenizedUrl`.
