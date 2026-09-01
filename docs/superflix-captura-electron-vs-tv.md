# SuperFlix: como o Electron captura a mídia e o que faltava na TV

O SuperFlix é o único provedor em que a extração pode terminar **dentro de uma
página do provedor**, com uma pessoa resolvendo o desafio e escolhendo o
servidor. Os outros provedores resolvem por HTTP puro e nunca precisam de tela.

Este documento descreve o mecanismo do Electron etapa por etapa e o equivalente
na TV, porque a diferença entre os dois foi a causa de a mídia capturada nunca
chegar ao Media3.

## Dois caminhos, nesta ordem

Nos dois ambientes o SuperFlix tem **dois** caminhos, e o segundo só existe
porque o primeiro pode esbarrar no Turnstile:

1. **Cadeia HTTP direta** — `superflix-extractor.js` no Electron,
   `SuperflixExtractor.kt` no Android. Baixa a página, acha `page_token` e
   `contentid`, pede `/player/bootstrap` (lista de servidores em JSON), e para
   cada servidor faz `POST /player/source` → `/player/redirect` → mídia. Não
   abre tela nenhuma.
2. **Tela do provedor** — `browser-extractor.js` no Electron,
   `SuperflixChallengeOverlay` no Android. Só entra quando (1) devolve
   `CloudflareChallengeException`. A pessoa resolve o desafio, escolhe o
   servidor, e o **tráfego da própria página** é observado.

A comparação abaixo é do caminho (2), que é onde a TV divergia.

## Etapa por etapa

| Etapa | Electron (`browser-extractor.js`) | TV / Android | Situação |
|---|---|---|---|
| Apresentar o provedor | `WebContentsView` com wrapper local que embute o provedor num `<iframe>` | overlay com `loadDataWithBaseURL` + `<iframe>` | equivalente |
| Referer real de cada requisição | `webRequest.onSendHeaders` guarda o Referer por `details.id` | `header(request, "Referer")` em `shouldInterceptRequest` | equivalente |
| Marco da escolha de servidor | `/player/source` aparece no `webRequest` da sessão | **faltava** — nada marcava a escolha | corrigido: `servidor_confirmado` |
| Navegação depois da escolha | `onBeforeRedirect` captura o destino de `/player/redirect` | redirects reaparecem como novas requisições; o salto do CDN é seguido pelo OkHttp | corrigido: `navegacao_pos_selecao` |
| **Status da resposta** | `onCompleted` entrega `statusCode`; `capture()` recusa `<200` e `>=400` | **faltava** — `shouldInterceptRequest` só vê o *pedido* | corrigido: ver abaixo |
| HLS supera MP4 visto antes | `completeMedia` troca mp4 → hls | `observeSuperflixMedia` só recusa trocar quando já há um HLS | equivalente |
| Janela de acomodação | `MEDIA_SETTLE_MS = 1800` para legendas | `SUPERFLIX_SUBTITLE_GRACE_MS = 1800` | equivalente |
| Entrega ao player | `{ stream, tipo, referer, subtitles }` | idem, mais o User-Agent que gerou o link | equivalente |

## A etapa que faltava: o status

Este é o ponto inteiro.

No Electron, `webRequest.onCompleted` entrega o `statusCode` da requisição que a
**própria página** fez, de graça, e `capture()` ignora qualquer coisa fora de
2xx/3xx. É por isso que o Electron nunca guardou a mídia do player que a página
dispara sozinha: o manifesto dele responde 403, e 403 nunca chegou a ser
candidato.

A WebView do Android não tem equivalente. `shouldInterceptRequest` é chamado
**antes** da requisição sair; não existe callback com a resposta. Medir o status
por fora — refazendo a requisição com OkHttp — mede *outra* requisição, e em URL
assinada de uso único as duas nem são a mesma coisa.

O equivalente real é **assumir a requisição**: `passarMidiaSuperflix` faz o
pedido por nós, com os cabeçalhos da própria WebView mais o cookie do
`CookieManager`, aprende o status, e devolve o corpo à página, que continua
funcionando. É o mesmo padrão que `fetchCdnDirect` já usa em produção para os
segmentos do CDN.

Escopo estreito de propósito: só candidata a mídia, só enquanto a observação está
aberta. Qualquer falha devolve `null` e a WebView busca sozinha, como sempre.

## Regra de aceitação na TV

Uma URL só vira fonte quando as duas condições valem:

1. apareceu **depois** de `/player/source` — a escolha real do servidor;
2. o CDN respondeu **2xx/3xx** para a requisição da própria página.

Trocar de servidor descarta a mídia do anterior. Uma candidata recusada entra
numa lista e não volta a ser guardada; a observação continua até vir a que
presta.

## Eventos do fluxo

Na ordem em que devem aparecer num log de diagnóstico:

```
overlay_aberto
overlay_tecla        tecla=CIMA|BAIXO|ESQUERDA|DIREITA|OK|VOLTAR
servidor_focado      x= y=          posição do ponteiro
overlay_toque        x= y= aceito=  toque sintético entregue à WebView
servidor_confirmado  origem=player/source
navegacao_pos_selecao
midia_candidata      tipo= status= posSelecao=
midia_validada       tipo= status= msAposSelecao=
midia_entregue_ao_player
tv_reproducao_iniciada
```

`servidor_focado` é a posição do ponteiro, não foco de DOM: o widget do desafio
vive num iframe de outra origem e o foco dentro dele não é observável de fora.

**Sucesso é `tv_reproducao_iniciada`.** `midia_entregue_ao_player` diz apenas que
a fonte saiu desta camada.

## Por que o ponteiro existe

O widget do Turnstile fica num iframe de `challenges.cloudflare.com`, dentro do
iframe do provedor, dentro do nosso documento. A navegação por setas da WebView
não atravessa esse aninhamento entre origens. Injetar JavaScript na página do
provedor resolveria — e é exatamente o que a blindagem do overlay existe para
evitar. Em vez disso as setas movem um ponteiro nosso e o OK entrega um
`MotionEvent` na coordenada: do lado da página é um dedo.

O tratamento das teclas fica na **raiz** do overlay, não na WebView. `WebView` é
um `ViewGroup`: `dispatchKeyEvent` desce primeiro para o filho com foco, e um
`OnKeyListener` na própria WebView só seria chamado se o evento voltasse sem ser
consumido — com o conteúdo focado, nunca voltava.

## Arquivos

| Papel | Arquivo |
|---|---|
| Cadeia HTTP (Electron) | `desktop/electron/superflix-extractor.js` |
| Tela do provedor (Electron) | `desktop/electron/browser-extractor.js` |
| Cadeia HTTP (Android) | `android/core-extractor/.../bridge/SuperflixExtractor.kt` |
| Tela do provedor (Android) | `android/core-extractor/.../bridge/SuperflixChallengeOverlay.kt` |
| Observação e status | `android/core-extractor/.../player/PlayerWebViewClient.kt` |
| Regra de aceitação | `android/core-extractor/.../bridge/PlayerState.kt` |
| Âncora da WebView na TV | `android/tv/.../ui/CamadaDesafio.kt` |
