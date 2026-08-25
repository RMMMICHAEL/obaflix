# Diagnóstico de reprodução no Android

Como descobrir, pelo terminal, em qual ponto um episódio deixou de tocar no APK —
e o que a análise do caminho de reprodução encontrou de errado.

## 1. Capturar

Com o aparelho ou emulador conectado:

```bash
powershell -File scripts/diag-android.ps1
```

Abra um episódio no app e pare com `Ctrl+C`. A saída mostra uma **trilha** por
tentativa de reprodução, com o tempo de cada passo e um veredito no fim:

```
=== trilha ab12  provedor=superflix  embed=superflixapi.sbs/serie/69470/1/4
  +2300ms extracao  cdn_liberado         host=hcloud.qzz.io  referer=embedplayer2.xyz
  +2800ms manifesto reescrito            linhas=42  master=true  host=embedplayer2.xyz
  +3000ms cdn       sem_referer          host=hcloud.qzz.io  hostLiberado=false
           ^ segmento pedido sem Referer/Origin - o CDN costuma devolver 403
  +3200ms cdn       status_nao_2xx       status=403  arquivo=init.mp4
  +3900ms player    js_video_erro        tipo=DECODIFICACAO  codigo=3

  VEREDITO t=ab12 [superflix]: NAO reproduziu - o elemento <video> abortou a reproducao
```

Opções úteis:

| Comando | Para quê |
| --- | --- |
| `-Tudo` | mostra cada passo do funil, não só alertas e falhas |
| `-Reler arquivo.txt` | reinterpreta uma captura já feita (aceita UTF-8 e UTF-16) |
| `-Dispositivo 127.0.0.1:21503` | quando o `adb` não acha o emulador sozinho |

O script grava a captura crua em `diag-android-<data>.txt`. Nenhum token aparece
na saída: o `ObaLog` remove a query das URLs antes de registrá-las, então o
relatório pode ser colado num chat.

Para inspecionar o DOM e a rede do player num APK de release:

```bash
cd android && ./gradlew assembleRelease -PdiagLogs
```

Isso liga `chrome://inspect/#devices` também no release. O log estruturado
(`[oba]`) sai sempre, independente dessa flag.

## 2. O funil

Cada linha traz a fase em que o app estava. Saber onde parou já diz de quem é o
problema:

| Fase | O que acontece | Se parou aqui |
| --- | --- | --- |
| `sessao` | app abriu, ambiente registrado | problema de configuração/WebView |
| `bridge` | o JS pediu a extração ao nativo | o player web não chegou a chamar |
| `extracao` | OkHttp busca o stream com o IP do usuário | provedor fora do ar, TLS, DNS |
| `provedor` | páginas, Cloudflare, escolha de fonte | o provedor mudou de rota ou barrou |
| `manifesto` | M3U8 baixado e reescrito para URLs absolutas | manifesto vazio, HTML no lugar do M3U8 |
| `cdn` | segmentos e MP4, com Referer/Origin injetados | 403 do CDN, timeout, rede |
| `player` | `<video>` e hls.js dentro da página | decodificação, formato, travamento |

A distinção que mais importa: **falhar em `extracao` é problema do provedor;
falhar em `cdn` ou `player` é problema nosso** — headers, MIME ou reescrita de
manifesto.

## 3. Como a instrumentação foi montada

- `android/.../bridge/ObaLog.kt` — logger estruturado. Cada tentativa de
  reprodução abre uma trilha (`t=ab12`); toda linha carrega o tempo desde o
  início dela, a fase e pares `chave=valor`. As últimas 240 linhas ficam num
  buffer: quando algo falha, a trilha inteira é reimpressa em bloco, então não é
  preciso caçar o contexto no meio do logcat do sistema.
- Uma **sonda JS** é injetada no `<head>` do documento principal (em
  `PlayerWebViewClient.fetchDocumentWithoutCsp`). Ela reporta o que só existe do
  lado do navegador e nunca chegava ao logcat: `MediaError` do `<video>` (com o
  código traduzido — 3 é decodificação, 4 é formato não suportado), erros fatais
  do hls.js com o status HTTP do fragmento, Promises rejeitadas, e travamento
  (esperando buffer há mais de 8s sem o tempo avançar). Tudo entra na **mesma
  trilha** das fases nativas, via `_obaflixBridge.logDiag`, que exige a mesma
  capability das outras chamadas — uma página de terceiro num iframe não
  consegue injetar linha nenhuma.
- As linhas `[diag/etapa]` que `src/lib/playerDiag.ts` já emitia passam a ser
  reconhecidas em `onConsoleMessage` e viram eventos da trilha.

## 4. O que a análise encontrou

### Corrigido

**1. O corpo da mídia usava o timeout de leitura do cliente comum (20s).**
`readTimeout` no OkHttp significa "tempo máximo entre dois bytes", e o corpo de
uma resposta de mídia é consumido preguiçosamente pelo WebView — quando o buffer
do player enche, ele simplesmente para de ler. Passados 20s, a leitura seguinte
estourava `SocketTimeoutException` no meio do stream: o vídeo travava ou o hls.js
reportava `fragLoadError` **numa requisição que havia respondido 200/206
normalmente**, o que tornava a causa praticamente invisível. Agora existe
`ObaflixApp.mediaClient`, sem read timeout e sem call timeout, compartilhando o
mesmo pool de conexões (senão cada segmento HLS refaria o handshake TLS).

**2. O header `Range` era lido com chave sensível a maiúsculas.**
`fetchCdnDirect` fazia `original.requestHeaders["Range"]`, enquanto o resto do
arquivo já usava um helper case-insensitive. Em aparelhos cuja WebView entrega
`range` em minúsculas, o header se perdia: o CDN devolvia o arquivo inteiro a
partir do byte zero e a busca na barra de progresso voltava ao começo do
episódio. Passou a usar o mesmo helper.

**3. Respostas OkHttp ficavam abertas quando o corpo vinha nulo.**
Dois caminhos de `return null` deixavam a conexão presa no pool até o GC. Agora
fecham explicitamente e registram `corpo_vazio`.

**4. `webView.destroy()` era chamado com a WebView ainda anexada.**
Deixava o Chromium desenhando numa view destruída quando a Activity é recriada
(rotação, troca de tema). Agora solta da hierarquia antes.

### Identificado, não alterado

Estes são riscos reais, mas mexer neles muda comportamento além do escopo de um
trabalho de diagnóstico — ficam registrados para decisão:

- **`runBlocking` dentro de `shouldInterceptRequest`.** A rota
  `/api/player/extract` executa a extração inteira de forma bloqueante na thread
  de rede da WebView. Numa extração SuperFlix, que pode passar de 20s, isso
  congela **todas** as outras requisições da página, não só essa. O caminho
  normal do Android usa a bridge assíncrona, então esse branch é fallback — mas
  quando é acionado, o sintoma é a página inteira parecendo travada.
- **`isM3u8` trata qualquer URL contendo `.txt` como manifesto**, inclusive
  quando o `.txt` está na query. Um segmento com esse formato de URL seria
  reescrito como playlist e corrompido.
- **`PlayerState.allowCdnHost` faz resolução DNS síncrona** dentro da reescrita
  do manifesto, uma vez por host novo. É rápido no caso comum, mas um DNS lento
  atrasa a entrega do M3U8 inteiro.
- **Renderer morto por memória.** Os logs anteriores mostram heap de ~9 MB com GC
  constante durante a reprodução. O app já sobrevive à morte do renderer
  (`onRenderProcessGone` + `rebuildWebViewAposCrash`), mas o usuário perde a
  posição do vídeo. `android:largeHeap="true"` reduziria a frequência.
- **WebView abaixo da 118** continua enviando `X-Requested-With` ao provedor —
  não há contorno seguro, mas agora isso aparece no log como
  `requested_with_nao_suportado`, então dá para correlacionar com falhas de
  Cloudflare em aparelhos antigos.

## 5. Arquivos

| Arquivo | Papel |
| --- | --- |
| `android/app/src/main/java/com/obaflix/bridge/ObaLog.kt` | logger estruturado, trilhas e higienização de URL |
| `android/app/src/main/java/com/obaflix/player/PlayerWebViewClient.kt` | sonda JS injetada + instrumentação de CDN/manifesto/documento |
| `android/app/src/main/java/com/obaflix/bridge/ObaflixBridge.kt` | `logDiag`, entrada do lado JS na trilha |
| `scripts/diag-android.ps1` | leitor de terminal: trilhas, funil e veredito |
| `scripts/capturar-log-android.ps1` | captura crua anterior, ainda útil para grep livre |
