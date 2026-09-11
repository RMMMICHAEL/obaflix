# Canais ao vivo — diagnóstico do provider e arquitetura resultante

Medição feita em 11/09/2026 contra o provider de canais, sobre a varredura de
136 canais. Este documento é a justificativa de praticamente todas as decisões
em `src/lib/canais/`, `workers/media-proxy/src/canais.ts` e nas três interfaces.

Se alguém for "otimizar" algo aqui um dia, é este arquivo que explica por que a
coisa aparentemente redundante existe.

## O que foi medido

```text
Referer obrigatório:                 NÃO   (200 sem Referer, e com Referer errado)
User-Agent consistente obrigatório:  NÃO   (200 com UA em branco, curl, okhttp)
Cookie obrigatório:                  NÃO   (nenhum Set-Cookie na página do player)
Cookie precisa persistir:            NÃO   (não existe cookie)
IP parece vinculado:                 SIM   (evidência forte — ver abaixo)
Manifest exige contexto:             SIM   — mas de ORDEM, não de cabeçalho
Segmentos exigem contexto:           herdam o grant do IP
URL expira:                          NÃO   — permanente e estável por canal
Re-resolução recupera:               SIM   (armar devolve 200 imediatamente)
Validade do grant observada:         > 26 min sem expirar
```

## O mecanismo, reproduzido em três canais virgens

```text
manifesto a frio ..................... 403
GET na página do player .............. 200
manifesto logo depois, com UA lixo,
  sem Referer, sem cookie, de outro
  processo ........................... 200
```

Não é anti-hotlink por cabeçalho. É um **grant de estado no servidor do
provider, por par (IP, canal)**, armado por um GET na página do player.

**Por que (IP, canal) e não global:** num lote de 18 canais, 17 deram 403 a
frio — incluindo Globo, SBT, Record, HBO e Cartoon Network, que certamente
tinham outros espectadores naquele instante. Se o arm fosse global, esses
estariam quentes. E armar um canal não liberou outro.

**Incerteza residual:** não foi possível testar a partir de um segundo IP. A
arquitetura escolhida funciona sob as duas hipóteses (grant por IP ou por
sessão de rede), então essa incerteza não bloqueia nada — mas está registrada.

## O achado mais grave não é o 403

```text
URL .m3u8 capturada em 10/09, buscada em 11/09 com `curl -A curl-test`:  200
URL re-resolvida hoje == URL capturada ontem:                            18/18
```

A URL de mídia é **permanente, estável por canal e sem assinatura**. Uma vez
armada, qualquer pessoa com a string toca o canal indefinidamente.

Consequência: **entregar o `.m3u8` a um cliente, em qualquer plataforma, é
entregar o canal de graça e para sempre.** Não existe expiração para nos salvar
depois. É por isso que:

- `CanalFonte` não guarda `.m3u8` — guardar criaria o mesmo link eterno no nosso
  banco;
- `importar-canais.ts` lê `media_url` só como evidência e não grava;
- `POST /api/canais/[id]/play` **falha** quando `CANAIS_MEDIA_BASE` não está
  configurado, em vez de cair para "devolve o upstream".

## Detalhe operacional: os segmentos

Os segmentos não estão no host do manifesto. Vêm de um terceiro host e são
servidos como `Content-Type: text/css`, com extensão `.css` — mas o primeiro
byte é `0x47`, o sync byte de MPEG-TS. É disfarce para atravessar filtro.

Duas consequências no código:

1. A reescrita de HLS **não pode** procurar `.ts`/`.m4s` para achar segmento.
   `hls.ts` trata toda linha não-tag como URI de mídia, e decide manifesto ou
   segmento por `.m3u8`, nunca pelo contrário.
2. A allowlist de CDN precisa dos **dois** hosts. Um manifesto que resolve e
   segmentos que não é o modo de falha esperado quando só um estiver na lista.

## A arquitetura que isso obriga

```text
Android / Android TV / Electron
        │  POST /api/canais/{id}/play        (autentica, entitlement, rate limit)
        ▼
  Backend (Vercel)
        │  resolve: GET na página do player → acha a URL atual
        │  grava sessão no Redis (id opaco, TTL curto)
        │  devolve SÓ a URL de manifesto do nosso domínio, assinada
        ▼
  Media edge (Cloudflare Worker)
        │  confere assinatura + expiração
        │  lê a sessão pelo id opaco (Redis REST)
        │  ARMA (GET na página do player) e BUSCA — mesma invocação
        │    (o egress ser o mesmo é PREMISSA, provada por verificar-edge)
        │  reescreve o manifesto: nenhuma URL absoluta de upstream sobrevive
        ▼
  Aparelho
```

**Por que o edge é obrigatório, e não uma economia:** o grant é por IP, então o
backend resolver e o aparelho tocar dá 403 por construção. E como a URL nunca
expira, esconder é a única proteção que resta.

**Por que o edge arma:** quem arma tem de ser quem busca. Por isso `armar()` e
`buscarComArm()` vivem no Worker, e o arm que o resolver do backend provoca é
efeito colateral inútil — documentado para ninguém tentar cachear a resposta e
depois não entender o 403.

**Por que arm-on-403 uma única vez:** o 403 tem duas causas, grant ausente (que
o arm resolve) e canal fora do ar (que não resolve). Um laço transformaria a
segunda numa tempestade contra o provider.

## O egress do Worker precisa ser provado, não presumido

O desenho depende de a página do player e a mídia saírem do **mesmo IP**. "Mesma
invocação" **não é promessa contratual de IP de egress estável na Cloudflare** —
IP de egress dedicado é recurso à parte, e a plataforma pode sair por endereços
diferentes.

Se sair, o sintoma não é vazamento: é 403 teimoso, ou canal que só toca de vez
em quando — o tipo de falha que se descobre tarde e se debuga mal.

Por isso, **antes de ativar**, contra o Worker que vai servir o Obaflix:

```powershell
# 1. chame POST /api/canais/{id}/play autenticado e copie `manifestUrl`
npm run canais:verificar-edge -- "<manifestUrl>"
```

O script pede o manifesto doze vezes, cada uma uma invocação nova, e classifica:

| Resultado | O que quer dizer |
|---|---|
| 12/12 com manifesto | aprovado, arm + fetch funciona |
| parte 200, parte 403 | egress varia — ver saídas abaixo |
| 0/12 | concessão vencida, allowlist vazia, ou canal fora do ar |

**Se o egress variar, a ativação para.** Não há aqui uma saída já sabida — há
candidatas, e cada uma precisa ser **testada com o mesmo `verificar-edge`** antes
de ser adotada:

| Candidata | O que se sabe | O que **não** se sabe |
|---|---|---|
| **Dedicated CDN Egress IPs** (Cloudflare) | é o recurso que a Cloudflare documenta para egress dedicado de Workers | se está disponível no nosso plano, e o custo |
| **Durable Object** armando e servindo | dá uma instância única com identidade lógica estável | **não é garantia contratual de IP público fixo.** Pode ajudar, pode não mudar nada — é hipótese a investigar, não solução |
| **Proxy de saída próprio** com IP fixo | resolve o IP por construção | volta a pagar banda, que é o custo que o `workers/media-proxy` existe para evitar |

A regra, escrita para não ser esquecida no calor do momento:

1. `verificar-edge` intermitente → **parar a ativação**;
2. escolher uma candidata e **testá-la**;
3. **não** assumir que mover para Durable Object resolveu — só o
   `verificar-edge` contra a implementação nova diz isso.

Nenhuma delas é improviso em cima do player de filmes/séries, e nenhuma muda o
contrato dos clientes — o aparelho continua vendo só a URL do nosso domínio.

## Configuração necessária

Backend (Vercel):

| Variável | O que é |
|---|---|
| `CANAIS_MEDIA_BASE` | Base pública do Worker. Sem ela, `/play` devolve 503. |
| `CANAIS_CDN_ALLOWLIST` | Sufixos de host de mídia, separados por vírgula. **Sem ela nada passa** — allowlist vazia que nega é um canal fora do ar; que libera é um SSRF. |
| `CANAIS_MEDIA_SIGNING_SECRET` | **Segredo próprio, criado só para isto.** Gere com `openssl rand -base64 32`. |
| `CANAIS_PLAYER_HOST` | Opcional. Sobrescreve o host da página do player. |

Worker (`wrangler secret put` / `vars`):

| Variável | O que é |
|---|---|
| `ASSINATURA_SECRET` | O mesmo valor de `CANAIS_MEDIA_SIGNING_SECRET`. |
| `CDN_ALLOWLIST` | Os mesmos sufixos de `CANAIS_CDN_ALLOWLIST`. |
| `CANAIS_PLAYER_ALLOWLIST` | Sufixos permitidos para a **página que arma o grant**. Lista própria, não a de CDN. Vazia recusa o arm. |
| `CANAIS_MEDIA_BASE` | A própria base pública, para reescrever o manifesto. |
| `APP_ORIGIN` | Origem do app — a mesma `OBAFLIX_URL` que Android e Electron carregam. É o CORS que deixa o `hls.js` do renderer buscar o manifesto. O player nativo da TV não passa por CORS. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | A sessão de canal. |

### Por que a chave de canais não é o `NEXTAUTH_SECRET`

Porque o Worker roda em infra de terceiro, com outra superfície de deploy e
outra lista de quem pode ler secrets. Com a chave compartilhada, um vazamento lá
comprometeria também a assinatura de sessão de autenticação do produto inteiro.
Com chave própria, o pior caso passa a ser "emitir URL de mídia válida" — ruim,
e limitado. E rotacionar a chave de canais invalida as concessões em voo e nada
além disso, que é rotação barata.

Os hosts de CDN **não estão no repositório** por decisão: domínio de CDN em diff
é bloqueador pela regra de vazamento do projeto, e é metade do que falta para
alguém montar a URL sozinho.

## Ordem de ativação

1. Gerar `CANAIS_MEDIA_SIGNING_SECRET` (`openssl rand -base64 32`). É o mesmo
   valor nos dois lados, e **não** é o `NEXTAUTH_SECRET`.
2. Aplicar `prisma/migrations/20260911_canais/` e conferir com o `VERIFICACAO.sql`.
3. `npm run canais:importar -- <arquivo.json>` (simulação), depois `--aplicar`.
   Tudo entra `premium` e desativado.
4. Publicar o Worker com os secrets, `CDN_ALLOWLIST` e `CANAIS_PLAYER_ALLOWLIST`.
5. Configurar `CANAIS_MEDIA_BASE` e `CANAIS_CDN_ALLOWLIST` no backend.
6. Liberar **poucos** canais para teste:
   `npm run canais:curadoria -- --slug globosp --nivel gratuito --ativar --aplicar`
7. **Rodar `npm run canais:verificar-edge -- "<manifestUrl>"`** contra o Worker
   publicado, com uma concessão fresca. **Sem APROVADO, não seguir** — é aqui
   que se descobre se o egress do Worker sustenta o arm.
8. Só então abrir a curadoria completa — `--exportar` / `--importar` levam a
   matriz para fora do código.

Rollback: tirar `CANAIS_MEDIA_BASE` derruba só canais (`/play` passa a 503),
sem deploy e sem tocar em filmes e séries.

## As validades, e o que cada uma segura

| | Quanto | Segura |
|---|---|---|
| URL de manifesto (grant) | 5 min | URL capturada morre rápido |
| URL de segmento | 90 s | link não sobrevive ao instante em que foi útil |
| Grace de handoff | 60 s | janela em que as duas gerações convivem |
| Sessão no Redis | 7 min, deslizante | sessão abandonada morre sozinha |
| Vida máxima da sessão | 2 h | força re-resolução no provider |
| Mapa id→base | 6 h | tabela imutável; perder uma entrada só custa redescoberta |

O cliente volta a `POST /api/canais/{id}/play` a ~60% do grant, mandando
`sessionId`. Essa volta é **reautorização de verdade**: reconfere sessão,
entitlement e rate limit, e **rotaciona o nonce** da sessão. Como o nonce entra
no material assinado e nunca viaja na URL, rotacioná-lo derruba as URLs emitidas
antes.

### O handoff, e por que ele precisa existir

Rotacionar o nonce sem mais nada **mata a reprodução em curso**: no instante da
renovação, o manifesto e os segmentos que o player está usando param de
conferir. Foi assim que a primeira versão saiu, e é o defeito que o protocolo
abaixo conserta.

```text
t=0        concessão A, player tocando por A
t=0.6·V    renova ──► servidor gira o nonce
                      A entra em grace (60 s)
                      concessão B devolvida
t=0.6·V    o cliente TROCA A FONTE do player para B
t=0.6·V+60 A morre
```

Duas peças, e as duas são obrigatórias:

- **No servidor**, a sessão guarda `nonce` e `noncePrevio`, e o edge aceita o
  anterior só até `graceAte`. Durante a janela, servir a URL **antiga** de
  manifesto devolve segmentos assinados com a geração **nova** — o que faz a
  troca ser quase invisível.
- **No cliente**, `trocarFonte` chama `hls.loadSource(url)` (React/Electron) ou
  `setMediaItem` + `prepare` (Android TV). Guardar a URL numa variável **não é
  migrar**, e era exatamente o que faltava.

O protocolo vive em `src/lib/canais/handoff.ts` e em
`HandoffDeCanal.kt`, testado dos dois lados. O teste de integração do edge
(`src/lib/__tests__/canaisEdge.test.ts`) percorre A → B → grace → morte de A →
revogação.

**Apagar a sessão não tem grace.** Logout, revogação e entitlement perdido matam
as duas gerações no mesmo instante.

### Concorrência: duas defesas no cliente

A sessão carrega uma **geração monotônica** (`geracao`, +1 a cada renovação), e
ela sai na concessão. O cliente usa isso para duas coisas:

- **Single-flight** — enquanto um pedido está em voo, quem chegar junto espera o
  mesmo resultado em vez de disparar outro. Um `Mutex` não resolve: serializar
  três chamadas ainda gasta três pedidos, e cada pedido gira o nonce.
- **Guarda monotônica** — se duas respostas chegarem fora de ordem, a mais
  antiga é **recusada**. Sem ela o cliente regrediria para uma geração já
  aposentada, cuja URL morre na grace seguinte, e o 403 apareceria minutos
  depois, longe da causa.

O nonce não serve para ordenar: é opaco e aleatório de propósito.

### O custo da troca, medido

`hls.loadSource()` **não preserva a posição** — medido contra uma live local:
`currentTime` 7,983 antes, 6,010 depois. E `duration` de uma live é `Infinity`,
então uma guarda do tipo `Number.isFinite(duration) && t < duration` nunca
dispara e a posição se perde calada.

Os dois clientes restauram a posição à mão:

- **web** — pelo **buffer**: se o ponto anterior ainda está bufferizado na fonte
  nova, volta-se a ele; senão, fica na borda (o certo numa live);
- **TV** — `setMediaItem(item, resetPosition = false)`, travado por
  `TrocaDeFonteTest`. A sobrecarga de um argumento só reseta sempre.

Sobra um corte curto a cada ~3 min. **Se isso incomodar em produção, a saída não
é alongar a concessão** — é manter a URL do manifesto estável pela vida da
sessão e rotacionar só os segmentos (que é onde estão a banda e o valor de
replay). O manifesto continuaria morrendo com a sessão (7 min sem renovar) e na
revogação (imediato), e o player nunca precisaria trocar de fonte. É decisão de
produto, e está registrada aqui em vez de ser tomada no meio de uma correção.

### O que os testes ainda não cobrem

A continuidade **visual** — vídeo tocando, frames avançando durante a troca —
não é coberta automaticamente: aba oculta suspende reprodução, e emulador de TV
não estava disponível. O harness e o passo a passo estão em
`scripts/continuidade/README.md`, e é o único item da validação que depende de
um operador humano.

O que o edge **não** faz, e não pode: identificar quem está pedindo. A requisição
do player não carrega credencial nossa. O `sub` da sessão é conferido pelo
backend na renovação — é o que impede renovar a sessão de outra conta com um
`sessionId` capturado —, e não no edge.

## As bases, e o que a query **não** esconde

Uma URL de segmento do edge é `…/s/<idDaBase>/<caminho+query>?e=&k=`.

**`idDaBase` é opaco e determinístico** — `HMAC(chave, base)` truncado. Não é
mais um índice em vetor, e a diferença é de correção: com índice guardado no
documento da sessão, duas descobertas concorrentes disputavam o mesmo `SET`, e o
índice 1 de um manifesto podia acabar apontando para a base do outro. Índice
errado é pior do que ausente. Sendo derivado do conteúdo, o id não depende de
ordem, gravar é idempotente, e o pior caso virou "não encontrada" — que o edge
recusa e o player resolve rebuscando o manifesto.

**Gravar a base é obrigatório antes de servir.** Se o Redis falhar, o edge
responde **503** e não entrega o manifesto: entregá-lo daria ao player um
documento cujos segmentos todos respondem 403 — falha que parece revogação e não
é. A renovação de TTL da sessão, essa sim, continua best-effort, porque nada já
servido depende dela.

**A query do upstream não é secreta neste desenho.** Ela viaja
percent-encodada, e `encodeURIComponent` é reversível por qualquer um:
`seg.ts?token=abc` vira `seg.ts%3Ftoken%3Dabc` e decodificar é um clique. O que
se esconde é o **host**, pelo id opaco.

O provider medido na Fase A não põe nada na query, e por isso o caminho
reversível é aceitável hoje. Mas fica a regra, e ela não é opcional:

> Um provider futuro que traga **credencial ou token sensível na query** do
> segmento **não pode usar este caminho como está**. Para ele, o valor precisa
> ficar no servidor e a URL carregar só um identificador opaco — o mesmo padrão
> que o `idDaBase` já aplica ao host, e que serve de molde.

## O que ficou de fora, e por quê

- **EPG.** Não existe fonte confiável nesta fase. Nenhuma das três interfaces
  mostra programa, horário ou progresso — só `AO VIVO`.
- **Canais adultos.** `playboy` e `sexyhot` entram marcados `adulto` e ficam
  fora do catálogo, travados por CHECK no banco e por filtro na consulta.
  Publicá-los exige perfil com PIN parental, que não existe.
- **Play Integrity / pinning / detecção de root.** Ver a seção de riscos no PR:
  são camadas adicionais, e nenhuma delas muda o fato de que a decisão fica no
  servidor.
