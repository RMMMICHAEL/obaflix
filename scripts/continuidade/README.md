# Continuidade de reprodução no handoff — harness manual

Mede o que nenhum teste de unidade consegue: o que acontece com a **reprodução
de verdade** quando a fonte do player é trocada numa renovação.

Não roda em CI, e não deve: precisa de `ffmpeg`, de um navegador e de uma janela
**visível** — navegador esconde aba, e aba escondida suspende vídeo.

## Rodar

```powershell
# 1. gerar um HLS ao vivo local (deixe rodando)
mkdir $env:TEMP\hlslive; cd $env:TEMP\hlslive
ffmpeg -re -f lavfi -i "testsrc=size=640x360:rate=25" -f lavfi -i "sine=frequency=440" `
  -c:v libx264 -preset ultrafast -tune zerolatency -g 50 -c:a aac `
  -f hls -hls_time 2 -hls_list_size 6 -hls_flags delete_segments+omit_endlist `
  -t 600 live.m3u8

# 2. servir (noutro terminal, na raiz do repo)
node scripts/continuidade/servidor.mjs $env:TEMP\hlslive node_modules/hls.js/dist/hls.min.js

# 3. abrir http://127.0.0.1:8791/ num navegador VISÍVEL e, no console:
await document.getElementById("v").play();
const antes = __medir(); antes
__trocar("/stream/live.m3u8?g=2");      // simula a renovação
// espere ~5 s
const depois = __medir();
({ antes, depois, deltaT: depois.currentTime - antes.currentTime,
   framesNovos: depois.frames - antes.frames })
```

## O que se espera

| Medida | Critério |
|---|---|
| `deltaT` | perto de 0 — a troca **não** pode rebobinar nem reiniciar |
| `framesNovos` | > 0 depois da troca — o decodificador voltou a produzir |
| `paused` | `false` — a reprodução continuou |
| `eventos` | sem `fatal:` |

## O que já foi medido, e o que isso mudou no produto

Numa execução com a aba **oculta** (o pane do agente), com o vídeo em pausa
forçada pelo navegador, a troca ainda revelou o essencial:

```text
antes   currentTime 7.983   buffer [6.010, 12]
depois  currentTime 6.010   buffer [6.010, 12]
```

**`hls.loadSource()` não preserva a posição.** Ele reposiciona pela playlist
nova. E `duration` de uma live é `Infinity`, então qualquer guarda escrita como
`Number.isFinite(duration) && t < duration` — que era a primeira versão — nunca
dispara, e a posição se perde em silêncio.

Por isso `PlayerDeCanal.tsx` restaura a posição à mão, e a condição é o
**buffer**, não `duration`: se o ponto anterior ainda está bufferizado na fonte
nova, volta-se a ele; se a janela da live já passou por cima, fica na borda, que
é o certo para uma transmissão.

**O que este harness ainda não provou:** a continuidade visual com o vídeo
realmente tocando. A aba oculta suspende a reprodução (`visibilityState:
hidden`, `paused` preso em `true` mesmo com `play()` resolvendo), então
`currentTime` não avança e `framesNovos` não mede o que deveria. Rodar os passos
acima numa janela visível fecha essa lacuna — é o único item da validação de
canais que depende de um operador humano.

## Android TV

O equivalente do lado do Media3 é `TrocaDeFonte`, com o contrato travado em
`TrocaDeFonteTest` (JVM): a troca chama `setMediaItem(item, resetPosition =
false)` e a posição sobrevive. O que fica fora de cobertura automática é a
mesma coisa — a continuidade visual —, e depende de um aparelho:

```
adb install -r android/tv/build/outputs/apk/debug/tv-debug.apk
# abrir um canal, deixar tocando 4 min (duas renovações), observar:
#  - sem corte longo nem volta ao início
#  - sem 403 no logcat
adb logcat -s ExoPlayerImpl:* ObaLog:*
```
