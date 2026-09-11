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
        │  ARMA (GET na página do player) e BUSCA — mesma invocação, mesmo egress
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

## Configuração necessária

Backend (Vercel):

| Variável | O que é |
|---|---|
| `CANAIS_MEDIA_BASE` | Base pública do Worker. Sem ela, `/play` devolve 503. |
| `CANAIS_CDN_ALLOWLIST` | Sufixos de host de mídia, separados por vírgula. **Sem ela nada passa** — allowlist vazia que nega é um canal fora do ar; que libera é um SSRF. |
| `CANAIS_PLAYER_HOST` | Opcional. Sobrescreve o host da página do player. |
| `NEXTAUTH_SECRET` | Já existe. É de onde sai a chave de assinatura. |

Worker (`wrangler secret put` / `vars`):

| Variável | O que é |
|---|---|
| `ASSINATURA_SECRET` | O mesmo valor de `NEXTAUTH_SECRET`. |
| `CDN_ALLOWLIST` | Os mesmos sufixos de `CANAIS_CDN_ALLOWLIST`. |
| `CANAIS_MEDIA_BASE` | A própria base pública, para reescrever o manifesto. |
| `APP_ORIGIN` | Origem do app — a mesma `OBAFLIX_URL` que Android e Electron carregam. É o CORS que deixa o `hls.js` do renderer buscar o manifesto. O player nativo da TV não passa por CORS. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | A sessão de canal. |

Os hosts de CDN **não estão no repositório** por decisão: domínio de CDN em diff
é bloqueador pela regra de vazamento do projeto, e é metade do que falta para
alguém montar a URL sozinho.

## Ordem de ativação

1. Aplicar `prisma/migrations/20260911_canais/` e conferir com o `VERIFICACAO.sql`.
2. `npm run canais:importar -- <arquivo.json>` (simulação), depois `--aplicar`.
   Tudo entra `premium` e desativado.
3. Publicar o Worker com os secrets e a allowlist.
4. Configurar `CANAIS_MEDIA_BASE` e `CANAIS_CDN_ALLOWLIST` no backend.
5. Liberar **poucos** canais para teste:
   `npm run canais:curadoria -- --slug globosp --nivel gratuito --ativar --aplicar`
6. Só então abrir a curadoria completa — `--exportar` / `--importar` levam a
   matriz para fora do código.

Rollback: tirar `CANAIS_MEDIA_BASE` derruba só canais (`/play` passa a 503),
sem deploy e sem tocar em filmes e séries.

## O que ficou de fora, e por quê

- **EPG.** Não existe fonte confiável nesta fase. Nenhuma das três interfaces
  mostra programa, horário ou progresso — só `AO VIVO`.
- **Canais adultos.** `playboy` e `sexyhot` entram marcados `adulto` e ficam
  fora do catálogo, travados por CHECK no banco e por filtro na consulta.
  Publicá-los exige perfil com PIN parental, que não existe.
- **Play Integrity / pinning / detecção de root.** Ver a seção de riscos no PR:
  são camadas adicionais, e nenhuma delas muda o fato de que a decisão fica no
  servidor.
