# Obaflix — instruções do projeto

## Regra obrigatória: três ambientes oficiais

O Obaflix roda em **três ambientes**, e os três são oficiais:

| Ambiente | Onde vive |
|---|---|
| **Website** | Vercel — `src/app/api/player/*`, `src/components/player/*`, `src/lib/*` |
| **Electron** | `desktop/electron/*` — exe Windows |
| **Android** | `android/app/src/main/java/com/obaflix/*` — APK |

**Nenhuma correção está concluída porque funciona em um ambiente só.**

Toda mudança que toque **extractor, provider, headers, Referer, tokens, proxy,
HLS ou tratamento de erro** precisa ser analisada e validada nos três antes de
ser considerada pronta. Vale mesmo quando o bug foi reportado em um só: os três
têm implementações separadas do mesmo fluxo, e a que não foi tocada fica para
trás em silêncio.

### O que checar em cada mudança desse tipo

1. **Descoberta do embed** — a fonte chega igual nos três?
2. **Fallback entre espelhos** — mesma lista, mesma ordem, host recebido primeiro
3. **Referer/Origin** — precisa ser o host que **realmente respondeu**, nunca a
   URL recebida quando houve fallback
4. **Extração da mídia** — mesmo parser, mesmas chaves
5. **Validação do manifesto** — master vivo antes de entregar ao player
6. **Entrega HLS** — quem faz a requisição ao CDN muda por ambiente (ver abaixo)
7. **404 / 410 / 403 / timeout / erro de rede** — classificação equivalente
8. **Fallback quando a fonte morre** — mesmo comportamento

### Comportamento equivalente, não código idêntico

A implementação técnica difere por ambiente (TypeScript/Node na Vercel,
JavaScript no Electron, Kotlin no Android). O que precisa ser igual é o
**comportamento observável**. Não duplique lógica sem necessidade; quando um
ambiente já paga por uma requisição, use-a em vez de adicionar outra.

### Quem faz a requisição ao CDN

Isto muda tudo sobre onde a classificação de erro é possível de graça:

- **Website** — o proxy da Vercel busca o CDN. Já paga a requisição, então
  classificar status ali custa **zero** a mais.
- **Electron** — `main.js` redireciona `native=1` direto ao CDN e injeta headers
  via `onBeforeSendHeaders`. Nosso código não vê a resposta.
- **Android** — o WebView busca; `PlayerWebViewClient.shouldInterceptRequest`
  injeta os headers.

### Antes de implementar

1. Identifique as divergências entre os três **primeiro** e reporte
2. Só então faça a **menor mudança possível** para equalizar
3. Sempre estime impacto de consumo na **Vercel e no Supabase**, e prefira a
   opção mais econômica

## Regra obrigatória: revisão de segurança em toda alteração

Nenhuma alteração está concluída sem **revisão explícita de segurança**, junto da
revisão funcional e de consumo. Não vale descobrir a brecha depois.

Aplica-se sempre que a mudança tocar: **player, extractor, API, token, proxy, URL
de mídia, cache, banco, sessão ou frontend**.

### O que verificar

A mudança criou vazamento novo de:

- nome de provider, domínio real, credencial, URL interna, token
- informação de usuário, endpoint sensível
- exposição em logs, source maps, responses ou código cliente

Ou abriu:

- possibilidade de replay, hotlink, acesso sem sessão
- SSRF, CORS incorreto

### O que o relatório final precisa dizer

Três itens, sempre, mesmo quando o resultado é "nada":

1. **O que foi revisado** — quais superfícies foram checadas
2. **Risco encontrado** — ou "nenhum", explicitamente
3. **Mitigação aplicada** — ou por que não foi necessária

### Exposição por público

- **Usuário comum** — nomes genéricos (`Servidor 1`, `Servidor 2`). Nunca nomes
  reais de provider, domínios, tokens, querystrings sensíveis ou log detalhado.
- **Admin autenticado** — visão técnica completa: provider real, host, videoId,
  sourceId, tipo de mídia, rota, status e diagnóstico. O mapeamento real vive no
  backend ou em configuração não exposta ao cliente comum.

Detecção de DevTools, ofuscação e nomes genéricos são **dissuasão**, nunca a
proteção principal. A proteção real continua sendo sessão, token de curta
duração, expiração, rate limit e backend que não devolve o que não precisa.

## Outras regras

- Depois de commitar, **sempre** `git push` sem perguntar (branch atual → `main`)
- Mudou `android/` → gera APK. Mudou `desktop/electron/` → gera EXE. Sem perguntar.
- Nunca use `git add -A`: liste os arquivos explicitamente. Já commitou trabalho
  em andamento do usuário e quebrou o CI.
- Nunca edite regex via shell (`node -e`, `sed`): os escapes se perdem e o padrão
  passa a aceitar o que deveria recusar. Use ferramenta de edição direta.
