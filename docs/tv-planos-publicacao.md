# Android TV — planos e promoção: o que falta para publicar

Estado em 2026-09-13, branch `feat/tv-planos-promocao` (PR #27). Este documento
separa o que está **implementado** do que **bloqueia a publicação da oferta**.
Nada aqui foi aplicado em Production: nenhuma migration, nenhum preço, nenhuma
flag.

## 1. Continuação da assinatura no navegador do celular

### Fluxo implementado

```text
TV: card do plano → QR https://obaflix.online/planos?plano=<id>
Celular (navegador): /planos destaca "Plano escolhido na TV"
  → Assinar → /checkout?planoId=<id>&planoPrecoId=<preço>
  → sem sessão: /login?callbackUrl=/checkout?... (ou Criar conta, que preserva o retorno)
  → volta ao mesmo checkout → PIX existente
```

- `src/config/site-mode.ts` abre **só** `/planos`, `/checkout` e `/conta` para
  navegador comum. Catálogo, busca, canais, player, `/android` e `/desktop`
  continuam na landing (teste `siteModeAssinatura.test.ts`, inclusive prefixos
  parecidos como `/planosx`).
- Android e Electron: sem mudança de rota nem de código de app.
- Retorno de login e cadastro: só caminho interno (`caminhoInternoSeguro`),
  mesma regra que o login já aplicava.
- O QR leva apenas o id público do plano. Nenhum token, e-mail ou id de conta.
- Token de handoff: continua pendente (contrato em
  `android/tv/.../assinatura/LinkDeAssinatura.kt`). Hoje o login é normal.

### Dependência para o fluxo concluir uma compra

A API pública de Production (`GET /api/billing/plans`, lida em 2026-09-13)
devolve os três planos com `precos: []` e `compravel: false`. **Sem `PlanoPreco`
ativo, o checkout mostra "Plano temporariamente indisponível para compra"** — no
navegador, no app móvel e no Electron. Ver a seção 2.

## 2. Divergências comerciais

> **Atualização (definição comercial final):** esta seção registra a análise
> anterior. A matriz final, as fontes de verdade e as propostas de schema estão
> em `docs/planos-comerciais.md` (PR #28, base deste PR). A TV não tem mais
> tabela própria: nome, selo, tema, benefícios e preços vêm de
> `GET /api/billing/plans`. "Downloads com anúncio" no Básico foi removido; a
> qualidade aparece como "Suporte a…"; canais como "até o nível Plus/Premium"; o
> servidor VIP não aparece enquanto o direito não existir. O filtro server-side
> das fontes premium está implementado e desligado no PR #28.

Fontes: tela da TV (`PlanosTv.kt`); o que o backend concede (`Plano` em
Production via API pública + `src/lib/planos.ts` + `direitosAplicados.ts`); o que
o checkout oferece (`PlanoPreco` ativo, `resolverPreco`).

| Item | TV apresenta | Backend concede | Checkout oferece/cobra | Alteração mínima | Tipo |
|---|---|---|---|---|---|
| **Preço** | Básico R$ 10, Plus R$ 19,90, Premium R$ 29,90 / 30 dias | — | **nada**: nenhum `PlanoPreco` ativo | criar `PlanoPreco` (1000, 1990, 2990 centavos; 30 dias; BRL; ativo) | **dados** — sem migration |
| **Cobrança real** | — | — | depende de `BLACKCAT_PIX_ATIVO` e `BLACKCAT_CONFIRMACAO_ATIVA` | ligar as flags quando a cobrança for aprovada | **configuração** |
| Nome | "Básico" | `Plano.nome = "Basic"` | exibe "Basic" | `UPDATE Plano SET nome='Básico'` | dados |
| Telas | 2 | `telasMax = 2`, aplicado com a flag | — | nenhuma | alinhado |
| Filmes e séries | incluídos | `filmes/series = true`, aplicado | — | nenhuma | alinhado |
| Anúncios | Básico: sem anúncios após assinar; Plus/Premium: sem anúncios | `anunciosObrigatorios = false` nos três, aplicado | — | nenhuma | alinhado |
| **Qualidade Plus** | "Full HD" | `resolucaoMax = "hd"` | — | `UPDATE Plano SET "resolucaoMax"='fhd' WHERE id='plus'` (o CHECK já aceita `fhd`) | dados |
| **Qualidade (todas)** | HD / Full HD / até 4K | `resolucaoMax` é **gravado e não aplicado**: nenhuma rota limita qualidade | — | para virar garantia, código que filtre variantes por teto — sem migration; até lá o texto é teto comercial, não trava | código (futuro) |
| **Canais Plus** | "Canais de TV incluídos" | `canaisNivel = "plus"`: alcança canais `gratuito` e `plus`, **não** `premium` | — | decidir: texto "Canais do nível Plus" ou curadoria de `Canal.nivelMinimo` | texto ou dados |
| Canais Básico/Premium | não incluídos / incluídos | `nenhum` / `premium`, aplicado | — | nenhuma | alinhado |
| **Downloads Básico** | "Downloads com anúncio" | `downloads = false`: nenhum download. A política de anúncio usa `anunciosObrigatorios` para toda finalidade — não existe "download com anúncio" num plano sem anúncio | — | **exige direito novo** (ex. `Plano.downloadsComAnuncio`) + regra em `/authorize` e `direitosDoCliente` → **migration**. Sem migration, só mudando a oferta para "Sem downloads" | migration (ou decisão comercial) |
| Downloads Plus/Premium | sem anúncios | `downloads = true`, sem anúncio | — | nenhuma (download só existe no Electron) | alinhado |
| **Servidor VIP** | Básico opcional; Plus/Premium incluso | **não modelado** | não vendido | ver seção 3 | **migration — bloqueio** |
| Suporte / prioritário | Plus: suporte; Premium: prioritário | processo de atendimento, não direito técnico | — | processo operacional | fora do sistema |

**Efeito no celular.** O app móvel exibe `/planos` a partir dos mesmos dados.
Criar `PlanoPreco` ou mudar `Plano.nome`/`descricao` torna os planos compráveis e
muda o texto também no celular e no Electron — sem nenhuma mudança de código
nesses apps.

**Bloqueio de publicação:** a oferta da TV não deve ir a público enquanto
preço, Plus Full HD, canais do Plus, downloads do Básico e VIP não estiverem
alinhados ou com o texto ajustado por decisão comercial.

## 3. Servidor VIP

### O que existe

- `src/lib/fontes.ts` monta a **mesma lista para toda conta**. "Servidor N" é
  rótulo genérico; nada ali identifica fonte VIP.
- O único "VIP" com significado técnico é do provedor **Webcine**
  (`src/lib/cinevs.ts`): cada vídeo traz `is_premium`, e o provedor só entrega
  premium porque **a nossa conta no provedor** tem `has_vip_access`. É uma
  identificação confiável de vídeo premium **dentro dessa fonte**, feita no
  servidor (`/api/player/fonte-nativa` e `/api/player/extract`).
- Hoje esses vídeos premium são oferecidos **a qualquer conta**, inclusive
  gratuita — comportamento pré-existente.

### Por que não dá para aplicar com a estrutura atual

Existe onde filtrar (resolução server-side do Webcine), mas **não existe um
direito que diga quem pode**. `Plano` não tem coluna de VIP. As alternativas sem
migration são inaceitáveis:

- decidir por `planoId`/nome do plano — proibido pela arquitetura;
- usar outro direito como proxy (ex. `canaisNivel ≥ plus`) — daria VIP a quem
  não contratou e impediria o Básico com VIP avulso;
- regra no cliente ou rótulo visual — não é autorização.

### Proposta mínima (não aplicada)

1. Migration: `Plano.servidorVip BOOLEAN NOT NULL DEFAULT false` (Plus e
   Premium `true` por dados). O VIP avulso do Básico, depois, como direito da
   `Assinatura` ou adicional próprio.
2. `DireitosDoPlano.servidorVip`, entrada em `direitosAplicados.ts`.
3. Filtro server-side: com `MONETIZACAO_ATIVA`, vídeo Webcine `is_premium` só é
   listado e resolvido para quem tem `servidorVip === true` (em `extract` e
   `fonte-nativa`, que já resolvem no servidor). Sem direito: fonte marcada
   indisponível, nunca resolvida.
4. TV: "Ver planos" quando a fonte VIP for recusada.

**Até isso existir, a oferta de VIP é bloqueio de publicação.** Os cards da TV
mostram o texto da matriz aprovada, mas o PR não o declara concluído.

## 4. Política de promoção da TV

- **Frequência:** promoção antes de **cada** filme ou episódio novo pedido por
  conta gratuita na TV (`decidirPromocaoTv`). A cadência de três episódios do
  celular (`decidirAnuncio`) não se aplica à TV e continua igual no celular.
- **Separação:** a TV não lê nem escreve o contador de episódios do celular, e
  a marca de pago do celular não dispensa a promoção da TV (nem o contrário).
- **Promoção cancelada não some:** cada pedido abre um desafio próprio; voltar
  ao episódio anterior sem concluir pede a promoção de novo.

### Validades, uma a uma

| Estado | Nasce em | Validade | Vínculos | Uso |
|---|---|---|---|---|
| **Sessão promocional** (desafio) | `/api/playback/authorize` → `PROMOCAO_TV_NECESSARIA` | 5 min + duração do vídeo; renovada para o mesmo prazo no início | conta, aparelho de TV, conteúdo exato (filme ou série/temporada/episódio), finalidade reprodução, promoção congelada (URL, duração, versão) | consumida uma vez na conclusão (`DEL`); qualquer recusa na conclusão a queima |
| **Início da promoção** | `/api/ads/promocao/iniciar` | igual à sessão | a sessão | `SET NX`: retry devolve o mesmo instante |
| **Concessão** | `/api/ads/complete` válida | **5 min** | conta, finalidade, conteúdo exato | uso único em `/api/player/fontes` |
| **Marca de recuperação** | junto da concessão | **30 min** | conta, **aparelho**, reprodução, conteúdo exato | reutilizável — só autoriza reemissão |
| **Passe reemitido** | `/api/playback/authorize` com marca válida | **5 min** | conta, finalidade, conteúdo exato | uso único em `/api/player/fontes` |

**Condições para reemitir** (passe novo sem nova promoção), todas ao mesmo
tempo: conta gratuita na TV, mesmo aparelho, mesmo conteúdo exato, finalidade
reprodução, marca de recuperação dentro dos 30 min. Faltando qualquer uma, a
TV recebe nova promoção. Não existe contador: outro episódio, outro aparelho,
celular ou Electron nunca apagam uma promoção pendente.

### Concessão × marca de recuperação

| | Concessão da TV | Marca de recuperação da TV |
|---|---|---|
| Nasce em | `/api/ads/complete`, após promoção válida | junto da concessão |
| Duração | **5 min** (`TTL_CONCESSAO_PROMOCAO_TV_S`) | **30 min** (`TTL_RECUPERACAO_TV_S`) |
| Uso | **único**, consumida por `/api/player/fontes` | reutilizável dentro do prazo |
| Efeito | abre a sessão de fontes | faz `/authorize` emitir um **passe novo** (5 min, uso único) em vez de nova promoção |
| Abrangência | conta + reprodução + conteúdo exato | conta + **aparelho de TV** + reprodução + conteúdo exato |
| Não vale para | outro conteúdo, conta, finalidade | outro episódio, outra TV da conta, celular, Electron |

Para que serve a marca: resposta de conclusão perdida, player que caiu, voltar
ao mesmo episódio. Ela nunca abre mídia sozinha.

### Limite da verificação

O servidor valida sessão (desafio emitido por ele, conta, aparelho), sequência
(início antes da conclusão), tempo mínimo (duração configurada, pelo relógio
dele) e uso único. **Não comprova que um cliente modificado exibiu o vídeo** —
apenas que o tempo passou. Verificação `soft`, como Unity e Direct Link.

## 5. Smoke de interface

Ver o PR #27 para o registro do que foi executado. Dependências para concluir:

- **Emulador — tentado em 2026-09-13, bloqueado.**
  - `emulator -accel-check`: *"Android Emulator hypervisor driver is not
    installed on this machine"*.
  - AVD `Television_720p` (Android TV **x86**, API 36): o sistema sobe, mas o APK
    só traz `armeabi-v7a`, `arm64-v8a` e `x86_64` — não instala.
  - AVD temporário `x86_64` (imagem Google APIs API 34 com perfil `tv_1080p`,
    sem download): *"ERROR | x86_64 emulation currently requires hardware
    acceleration!"*. AVD removido depois da tentativa.
  - Para destravar: habilitar aceleração (AEHD ou WHPX — alteração de sistema,
    feita pelo responsável pela máquina) e ter uma imagem Android TV `x86_64`
    (download pelo SDK Manager, com autorização). As ABIs de release não foram
    alteradas.
- **Dispositivo:** nenhum aparelho conectado ao `adb`.
- **Preview:** o deploy do PR responde 302 (proteção de deploy do Vercel). TV e
  celular precisam de bypass de proteção ou deploy acessível.
- **Configuração do Preview (escopo da branch, nunca Production):**
  `MONETIZACAO_ATIVA=true`, `PROMOCAO_TV_VIDEO_URL`, `PROMOCAO_TV_DURACAO_SEG`,
  e `PlanoPreco` no banco usado pelo Preview.
- **Contas de teste:** gratuita, Básico, Plus e Premium, e alguém para parear a
  TV e fazer login no celular — credenciais não são digitadas pelo agente.
