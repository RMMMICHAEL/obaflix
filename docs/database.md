# Banco de Dados

## Arquivo

`prisma/schema.prisma`

## Setup

```bash
npx prisma db push     # aplica schema sem migration file (desenvolvimento)
npx prisma migrate dev # cria migration file (produção)
npx prisma studio      # interface visual local
```

## Modelos

### Filme

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `String @id` | ID único (gerado no import do Megaflix) |
| `tmdbId` | `String?` | ID no TMDB para metadata |
| `titulo` | `String` | Título em português |
| `tituloOriginal` | `String?` | Título no idioma original |
| `poster` | `String?` | URL do poster (TMDB) |
| `background` | `String?` | URL do backdrop (TMDB) |
| `logo` | `String?` | URL da logo transparente (TMDB) |
| `sinopse` | `String? @db.Text` | Sinopse |
| `ano` | `Int?` | Ano de lançamento |
| `nota` | `Float?` | Nota (TMDB) |
| `duracao` | `Int?` | Duração em minutos |
| `sagaId` | `Int?` | FK para `Saga` (coleções) |
| `urlDub` | `String? @db.Text` | URLs embed DUB, separadas por vírgula |
| `urlLeg` | `String? @db.Text` | URLs embed LEG, separadas por vírgula |

### Serie

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `String @id` | ID único |
| `tipo` | `String @default("serie")` | "serie" ou "anime" |
| `temporadas` | `Int?` | Número de temporadas |
| Demais campos | igual Filme | título, poster, etc. |

### Episodio

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `String @id` | ID único |
| `serieId` | `String` | FK para Serie |
| `numeroEp` | `Int` | Número do episódio |
| `temporada` | `Int` | Número da temporada |
| `titulo` | `String?` | Título do episódio |
| `thumbnail` | `String?` | URL da thumbnail |
| `urlDub` | `String? @db.Text` | URLs embed DUB |
| `urlLeg` | `String? @db.Text` | URLs embed LEG |

**Constraint unique:** `[serieId, temporada, numeroEp]` — previne episódios duplicados.

### WatchHistory

Tabela central para progresso de assistência e "Continuar Assistindo".

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `userId` | `String` | FK para User |
| `conteudoId` | `String` | ID do Filme ou Serie |
| `conteudoTipo` | `String` | `"filme"` ou `"serie"` |
| `episodioId` | `String?` | FK para Episodio (null para filmes) |
| `temporada` | `Int?` | Temporada do episódio |
| `numeroEp` | `Int?` | Número do episódio |
| `progressoSeg` | `Int @default(0)` | Posição em segundos (**sempre Int**) |
| `duracaoSeg` | `Int?` | Duração total em segundos (**sempre Int**) |
| `concluido` | `Boolean` | `true` se progressoSeg > 90% de duracaoSeg |
| `queued` | `Boolean` | `true` = próximo episódio pré-enfileirado |
| `filmeId` | `String?` | FK redundante para Filme (facilita joins) |
| `serieId` | `String?` | FK redundante para Serie |

**Constraint unique:** `[userId, conteudoId, episodioId]`

**Cuidado:** `progressoSeg` e `duracaoSeg` são `Int` no schema. O JW Player retorna `duration` como `float`. Sempre usar `Math.round()` antes de salvar.

### Watchlist

Filmes e séries na lista de "Quero Assistir" do usuário.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `userId + conteudoId + conteudoTipo` | `@id` composto | PK |
| `conteudoTipo` | `String` | `"filme"` ou `"serie"` |
| `addedAt` | `DateTime` | Quando foi adicionado |

### Like

Avaliação positiva/negativa por usuário.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `userId + conteudoId + conteudoTipo` | `@unique` | Um voto por conteúdo |
| `valor` | `Int` | `1` (gostei) ou `-1` (não gostei) |

### Genero / FilmeGenero / SerieGenero

Relação M:N entre conteúdo e gêneros via tabela de junção.

```
Genero ←→ FilmeGenero ←→ Filme
Genero ←→ SerieGenero ←→ Serie
```

### Saga

```typescript
model Saga {
  id   Int    @id
  nome String   // ex: "Universo Marvel", "Harry Potter"
}
```

Filmes com `sagaId` pertencem a uma coleção. Usado para exibir filmes relacionados.

### User

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `String @id @default(cuid())` | ID gerado pelo Prisma |
| `email` | `String @unique` | Email (lowercase, trimmed) |
| `senhaHash` | `String?` | bcrypt hash; null = conta Google |
| `role` | `String @default("user")` | `"user"` ou `"admin"` |
| `nome` | `String?` | Nome de exibição |
| `avatar` | `String?` | URL do avatar |

`assinaturas` é relação virtual do Prisma — não existe coluna em `User`.

### Plano

Um plano comercial e os direitos que ele concede. **O nome do plano nunca decide
nada**: quem decide é cada direito, coluna a coluna. É o que permite mudar plano
comercialmente sem publicar aplicativo novo.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `String @id` | Slug estável (`"gratuito"`). Serve à idempotência do seed, ao suporte e ao log. **Nunca ramifique lógica por ele** |
| `nome` | `String` | Exibição |
| `descricao` | `String?` | |
| `ordem` | `Int @default(0)` | Vitrine |
| `ativo` | `Boolean @default(true)` | Descontinuar plano é `ativo = false`, que preserva quem já comprou |
| `ehPadrao` | `Boolean @default(false)` | O plano de quem não tem assinatura ativa. Índice único parcial garante no máximo um |
| `anunciosObrigatorios` | `Boolean @default(true)` | Forma positiva de propósito — ausente ⇒ pede anúncio, falhando para o lado seguro |
| `episodiosPorAnuncio` | `Int?` | O `N` da regra de séries. `null` quando o plano não exibe anúncio |
| `janelaAnuncioHoras` | `Int @default(24)` | Janela do contador de episódios |
| `filmes` / `series` | `Boolean @default(false)` | Como todo direito: o default não concede. O seed do Gratuito libera as duas explicitamente |
| `canaisNivel` | `String @default("nenhum")` | `nenhum` \| `gratuito` \| `plus` \| `premium`. Direito separado de `anunciosObrigatorios` |
| `downloads` | `Boolean @default(false)` | |
| `telasMax` | `Int @default(1)` | Telas simultâneas. Substituirá `MAX_CONCURRENT` de `src/lib/playTokens.ts` |
| `perfisMax` | `Int @default(1)` | Reservado — perfis não existem no schema |
| `resolucaoMax` | `String @default("hd")` | `sd` \| `hd` \| `fhd` \| `4k` |
| `tvNivel` | `String @default("limitado")` | `nenhum` \| `limitado` \| `completo` |

O default de cada direito é o mais restritivo: um plano criado sem informar um
direito não o concede por acidente.

### PlanoPreco

Uma duração comprável de um plano. O plano Gratuito nasce **sem nenhuma linha
aqui** — ele não é comprável, e isso fica modelado em vez de virar caso especial.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `String @id @default(cuid())` | |
| `planoId` | `String` | FK → `Plano`, `ON DELETE CASCADE` |
| `rotulo` | `String` | "Mensal", "6 meses", "Anual" |
| `duracaoDias` | `Int` | CHECK `> 0` |
| `precoCentavos` | `Int` | **Centavos, inteiro, sempre.** Nunca float — o erro apareceria na conferência entre valor pago e esperado |
| `precoOriginalCentavos` | `Int?` | Valor riscado; `null` sem promoção |
| `moeda` | `String @default("BRL")` | |
| `ativo` | `Boolean @default(true)` | |
| `ordem` | `Int @default(0)` | |

### Assinatura

A assinatura pertence à **conta**, não ao perfil. Não existe coluna "é premium"
nem cache de direito: assinatura ativa é sempre derivada de
`status = 'ATIVA' AND iniciaEm <= now() < terminaEm`.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `String @id @default(cuid())` | |
| `userId` | `String` | FK → `User`, `ON DELETE CASCADE` |
| `planoId` | `String` | FK → `Plano`, `ON DELETE RESTRICT` — plano com assinante não pode ser apagado |
| `planoPrecoId` | `String?` | FK → `PlanoPreco`, `ON DELETE SET NULL` |
| `status` | `String` | `ATIVA` \| `EXPIRADA` \| `CANCELADA` \| `SUSPENSA` |
| `iniciaEm` / `terminaEm` | `DateTime` | CHECK `terminaEm > iniciaEm` |
| `origem` | `String @default("pagamento")` | `pagamento` \| `cortesia` \| `migracao` \| `admin` |
| `pedidoId` | `String? @unique` | Trava de idempotência: um pedido ativa no máximo uma assinatura. FK → `PedidoPagamento`, `ON DELETE NO ACTION` (Fase 4) |
| `observacao` | `String?` | Anotação de suporte. Nunca dado de pagamento, nunca documento |

### PedidoPagamento

Uma tentativa de compra. **Nunca um direito.** Um pedido existir, ter QR, ter
`transacaoId` e ter sido visitado não concede nada — quem concede é `Assinatura`,
e a única transição para `PAGO` é a confirmação servidor→servidor da Fase 5.

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `id` | `String @id @default(cuid())` | O identificador que o cliente recebe |
| `userId` | `String` | FK → `User`, `ON DELETE CASCADE` |
| `planoId` | `String` | FK → `Plano`, `ON DELETE RESTRICT` |
| `planoPrecoId` | `String` | FK → `PlanoPreco`, `ON DELETE RESTRICT`. **NOT NULL**, ao contrário de `Assinatura.planoPrecoId`: um pedido só nasce de um preço, então `SET NULL` é impossível |
| `provedor` | `String @default("blackcat")` | CHECK. Coluna, e não constante de código, porque a Fase 5 procura pedido por `(provedor, transacaoId)` |
| `status` | `String` | CHECK. Ver a máquina de estados abaixo |
| `valorCentavos` | `Int` | **Snapshot**, centavos, CHECK `> 0` |
| `moeda` | `String @default("BRL")` | |
| `duracaoDias` | `Int` | **Snapshot**, CHECK `> 0` |
| `refExterna` | `String @unique` | 128 bits aleatórios, gerados no servidor. Vai no `externalRef` da Blackcat |
| `transacaoId` | `String? @unique` | O `transactionId` do provedor. Só chega por resposta server-side; nulo até a venda existir. Único com múltiplos `NULL` permitidos, que é o que o Postgres faz |
| `expiraEm` | `DateTime?` | Quando o PIX deixa de ser pagável |

Índices: `@@index([userId, status, criadoEm])` para a listagem de suporte, e
`@@index([status, expiraEm])` para a varredura da reconciliação da Fase 5.

#### Os dois snapshots

`valorCentavos` e `duracaoDias` são cópias de `PlanoPreco`, não referências — e
isso é o desenho, não desnormalização por desempenho.

O preço pode mudar entre a criação do PIX e a confirmação do pagamento. Se a
Fase 5 conferisse o valor pago contra a tabela de preços **atual**, uma alteração
comercial no meio do caminho faria a conferência recusar um pagamento correto —
ou aceitar um incorreto. O pedido precisa saber quanto custava e qual duração
estava sendo comprada *naquele instante*.

#### Estados

```text
CRIADO ──► AGUARDANDO ──┬──► CONFIRMANDO ──► PAGO ──► ESTORNADO
                        ├──► EXPIRADO
                        ├──► CANCELADO
                        ├──► FALHOU
                        └──► REVISAO_MANUAL
```

Os nove estão no `CHECK` desde a Fase 4, para a Fase 5 não precisar de uma
migration de domínio no meio do fluxo de pagamento. **A Fase 4 escreve apenas
quatro:** `CRIADO`, `AGUARDANDO`, `FALHOU` e `REVISAO_MANUAL`.

A escolha entre os dois últimos segue uma regra só:

> **Transação conhecida ⇒ `REVISAO_MANUAL`. Transação desconhecida ⇒ `FALHOU`.**

Se sabemos o `transactionId`, existe uma venda no provedor que pode ser pagável;
`FALHOU` diria "não há nada lá" e faria a reconciliação da Fase 5 pular
justamente a linha que precisa de gente olhando. O `transacaoId` é gravado junto
para o cruzamento ser possível — e não concede nada: `REVISAO_MANUAL` não é um
estado que autorize.

Caem em `REVISAO_MANUAL`: valor devolvido diferente do snapshot; `status` da
criação diferente de `PENDING`; PIX já vencido na criação; e dados de PIX
inutilizáveis apesar de haver transação. Caem em `FALHOU`: timeout, erro de rede,
erro HTTP e resposta sem `transactionId` aproveitável.

**Passar a `AGUARDANDO` exige duas condições, não uma:** `HTTP 201` **e**
`data.status === "PENDING"`. O primeiro diz que a requisição foi aceita; o
segundo, em que estado a venda nasceu. Um `PAID` na resposta de criação não é
compra concluída — é anomalia, e vira `REVISAO_MANUAL`, nunca `PAGO`.

Os valores aceitos vivem em dois lugares — `STATUS_PEDIDO` em
`src/lib/billing/pedidos.ts` e o `CHECK` da migration.
`src/lib/__tests__/pedidoPagamento.test.ts` lê os dois arquivos e falha se
divergirem, mesmo mecanismo dos domínios da Fase 1.

#### O que esta tabela deliberadamente não guarda

Nada de `qrCode`, `copyPaste`, `qrCodeBase64`, CPF, telefone, `Authorization`,
cookie, chave de API ou payload do provedor. O QR vai na resposta HTTP
autenticada de quem acabou de criar o pedido e morre ali: guardar o copia-e-cola
transformaria um vazamento de backup em meio de pagamento utilizável, e guardar
documento sem necessidade contraria a retenção mínima (D-13).

#### `Assinatura.pedidoId` → `PedidoPagamento`

A coluna existe desde a Fase 1; a chave estrangeira entrou na Fase 4. Ela é
`ON DELETE NO ACTION`, e a escolha é técnica:

- **`CASCADE` está fora de questão.** Apagar um pedido apagaria a assinatura que
  ele originou — direito pago desaparecendo por causa de uma limpeza de pedidos.
- **`RESTRICT` recusaria o `DELETE` linha a linha.** `NO ACTION` faz a mesma
  recusa, mas verifica no fim do comando. A diferença aparece na exclusão de
  conta: `DELETE FROM "User"` cascateia para `Assinatura` *e* para
  `PedidoPagamento`, e a ordem entre as duas não é definida. Com `RESTRICT`,
  apagar o pedido antes da assinatura que o referencia abortaria a exclusão da
  conta. Com `NO ACTION`, no fim do comando as duas linhas já saíram e a
  verificação passa.

Na prática: apagar um pedido isolado continua sendo recusado, e apagar a conta
continua funcionando.

Opcionalidade e unicidade não mudaram — a coluna segue nullable e única, então um
pedido ativa no máximo uma assinatura, garantido pelo banco.

#### RLS

`ENABLE ROW LEVEL SECURITY`, **sem nenhuma policy e sem nenhum `GRANT`**, mesmo
critério das tabelas da Fase 1. Numa tabela que guarda valor cobrado e referência
de transação, a segunda camada importa mais do que nas outras.

### Domínio dos campos de texto

`canaisNivel`, `resolucaoMax`, `tvNivel`, `status` e `origem` de
`Plano`/`Assinatura`, e `status` e `provedor` de `PedidoPagamento`, são `String`
com `CHECK` no banco, não `enum` nativo. As razões, na ordem em que pesaram:

- evoluir um nível (acrescentar, renomear, restringir) fica dentro de uma
  migration SQL comum, que é como este projeto já escreve migration;
- `conteudoTipo` e `role` já são `String` — um `enum` criaria um segundo estilo
  para o mesmo tipo de campo;
- o `CHECK` é declarado explicitamente na migration, onde dá para lê-lo e
  alterá-lo;
- o Prisma não representa esses `CHECK` no schema, então a validação vive no
  banco de qualquer forma.

A contrapartida é que os valores aceitos passam a existir em dois lugares — as
constantes e os `CHECK` da migration correspondente. Um teste lê os dois arquivos
e falha se divergirem, então mexer num lado sem o outro quebra o CI, e não a
produção:

| Domínio | Constantes | Teste |
|---|---|---|
| `Plano` e `Assinatura` | `src/lib/planos.ts` | `src/lib/__tests__/planos.test.ts` |
| `PedidoPagamento` | `src/lib/billing/pedidos.ts` | `src/lib/__tests__/pedidoPagamento.test.ts` |

### Defaults restritivos

Todo direito de `Plano` tem o default que **não concede**: os booleanos em
`false`, `anunciosObrigatorios` em `true` (a forma que exige anúncio),
`canaisNivel` em `nenhum`, `resolucaoMax` em `hd`, `tvNivel` em `limitado`,
`telasMax` e `perfisMax` em `1`.

Um plano criado sem informar um direito não o concede por acidente. Quem libera
é sempre uma decisão escrita — inclusive no plano Gratuito, que escreve as suas
uma a uma. `planos.test.ts` verifica os defaults contra a migration.

### Aplicando a migration

`prisma/migrations/` **não tem `migration_lock.toml`**, e nenhuma das migrations
anteriores foi gerada por `prisma migrate dev` — todas são SQL escrito à mão, com
`IF NOT EXISTS`, feitas para serem **executadas diretamente** contra o Postgres
(editor SQL do Supabase, ou `psql` com a `DIRECT_URL`, que não passa pelo
pooler). `prisma migrate deploy` não é o caminho deste repositório: sem o lock e
sem histórico em `_prisma_migrations`, ele trata o banco como fora de controle.

Ordem, na sequência em que as fases foram escritas:

1. executar `20260910_planos_assinaturas/migration.sql` inteiro — ele próprio
   abre e fecha a transação;
2. rodar `20260910_planos_assinaturas/VERIFICACAO.sql` — só leitura, confere as
   três tabelas, os `CHECK`, o índice parcial de `ehPadrao`, o único de
   `pedidoId`, as chaves estrangeiras, o RLS e que nada foi populado. Toda
   coluna `ok` precisa vir `true`;
3. rodar o seed do plano padrão;
4. executar `20260910_pedido_pagamento/migration.sql` — cria `PedidoPagamento` e
   a FK de `Assinatura.pedidoId`. **Antes de criar a FK ele confere se existe
   `Assinatura.pedidoId` apontando para pedido inexistente e ABORTA a migration
   inteira se existir.** Não apaga e não corrige nada: dado órfão ali é direito
   concedido cuja origem se perdeu, e isso é decisão humana. Se abortar, investigue
   linha a linha — não limpe a coluna para fazer a migration passar;
5. rodar `20260910_pedido_pagamento/VERIFICACAO.sql` — confere a tabela, as
   colunas e tipos, os `CHECK`, os uniques, os índices, as FKs (inclusive que a
   nova é `NO ACTION`, e **não** `CASCADE`), o RLS, a ausência de policy e que
   nenhuma assinatura foi criada.

Cada arquivo abre `BEGIN` e fecha `COMMIT` sozinho: uma falha no meio não deixa a
fase pela metade — tabelas sem `CHECK`, ou com `CHECK` e sem RLS. Não depende de
quem executa lembrar de abrir a transação.

Sobre reexecutar: o arquivo foi escrito para **tolerar** reexecução
funcionalmente — `IF NOT EXISTS` nas tabelas e índices, `DROP CONSTRAINT IF
EXISTS` antes de cada `ADD` — e o resultado final é o mesmo. Mas **não deve ser
reexecutado casualmente depois que houver dados**: `DROP`/`ADD` de constraint
adquire lock na tabela, e o `ADD` revalida as linhas existentes. Com as tabelas
vazias isso é instantâneo; com uma tabela de assinaturas povoada, não é.

### A matriz comercial

Quatro linhas em `Plano`: o padrão `gratuito` mais os três compráveis. Os valores
vivem em `src/lib/planos.ts` e `src/lib/__tests__/matrizComercial.test.ts` trava
cada um.

| Direito | `gratuito` | `basic` | `plus` | `premium` |
|---|---|---|---|---|
| `ehPadrao` | **sim** | não | não | não |
| `filmes` / `series` | sim | sim | sim | sim |
| `anunciosObrigatorios` | não | não | não | não |
| `canaisNivel` | `nenhum` | `nenhum` | `plus` | `premium` |
| `downloads` | sim | **não** | sim | sim |
| `telasMax` | 5 | 2 | 2 | 2 |
| `perfisMax` | 1 | 1 | 1 | 1 |
| `resolucaoMax` | `4k` | `hd` | `hd` | `4k` |
| `tvNivel` | `completo` | `completo` | `completo` | `completo` |

`gratuito` **não é o degrau mais baixo da matriz** — é a fotografia do
comportamento atual, e por isso aparece acima de `basic` em telas, downloads e
resolução. Restringi-lo é o interruptor comercial real, com fluxo próprio.

**Os três comerciais nascem sem `PlanoPreco`**, logo não são compráveis:
`resolverPreco` recusa com `preco_inexistente`. É o estado pretendido enquanto os
valores comerciais não estiverem fechados.

`canaisNivel` é ordenado (`nenhum < gratuito < plus < premium`) e comparado com
`Canal.nivelMinimo` — nunca com nome ou categoria do canal. `basic` em `nenhum`
não alcança canal algum, nem os marcados `gratuito`; `plus` não alcança
`premium`; `premium` alcança os três.

**Nem todo direito da tabela é aplicado hoje**, e a classificação vive em
`src/lib/direitosAplicados.ts` — registro em código, com teste que impede a
marcação de envelhecer. Aplicados: `filmes`, `series`, `telasMax` e `downloads`.
Gravados sem consumidor: `resolucaoMax`, `tvNivel`, `perfisMax`,
`anunciosObrigatorios`, `episodiosPorAnuncio`, `janelaAnuncioHoras` — e
`canaisNivel`, cuja camada de aplicação existe mas ainda não está em `main`. Ver
a seção 5.1 de `docs/monetizacao-arquitetura.md`, inclusive para a ressalva sobre
`downloads` ser decisão de servidor obedecida no cliente.

**Semear a matriz está bloqueado.** O `gratuito` entrega mais que o Basic pago
(5 telas, download, 4K contra 2, nenhum, HD), e `seed:planos:apply` recusa
enquanto isso for verdade. A trava se levanta sozinha quando os direitos do
gratuito forem ajustados. Ver o bloco de bloqueador na seção 5 da arquitetura.

### Seed dos planos

```bash
npm run seed:planos          # dry-run, só mostra o que faria
npm run seed:planos:apply    # grava o que faltar
```

Cria as quatro linhas de `Plano` que faltarem, e **nenhuma** linha de
`Assinatura`, de `PlanoPreco` ou de `Canal`.

**Cria se faltar; nunca sobrescreve.** As constantes de `src/lib/planos.ts` —
`PLANO_GRATUITO` e os três de `PLANOS_COMERCIAIS` — são **bootstrap**, não
configuração permanente. Depois que a linha existe, o
**Postgres é a fonte de verdade**, inclusive e sobretudo quando alguém já ajustou
os direitos por decisão comercial. Rodar `--apply` com o plano existente não
altera nenhum campo: o script informa o que encontrou, aponta o que difere da
fotografia, e encerra com sucesso.

A razão é concreta. Com um banco de produção em `anunciosObrigatorios = true`,
`downloads = false`, `telasMax = 1`, um seed que sobrescreve devolveria tudo à
fotografia inicial — sem anúncio, com download, cinco telas. Um comando chamado
"seed" teria desligado a monetização e reaberto direitos, e nada no nome dele
avisaria.

O custo é conhecido e aceito: o seed **não** conserta uma coluna editada à mão.
Alteração comercial tem fluxo próprio, com intenção explícita. **Não existe
`--force`**, e não deve passar a existir nesta fase — uma flag que devolve o
comportamento perigoso reintroduz o risco com um passo a mais, e um passo a mais
não é uma barreira.

Os valores de **`gratuito`** são uma **fotografia do comportamento atual** do
Obaflix, e não um degrau da matriz: sem anúncio, com download, 4K, TV completa e
`telasMax = 5` (o `MAX_CONCURRENT` de hoje). É assim que a Fase 1 não mudou o
comportamento de nenhum usuário, e continua sendo assim — semear Basic, Plus e
Premium não toca em quem não assina.

### Divergência conhecida com `prisma migrate diff`

`Plano_ehPadrao_unico_idx` é um índice único **parcial**
(`... ON "Plano"("ehPadrao") WHERE "ehPadrao"`). O Prisma 5 não representa `WHERE`
em índice, então um `prisma migrate diff` futuro vai propor derrubá-lo. **Não
derrube** — é ele que garante, no banco, no máximo um plano padrão. Sem isso, dois
planos marcados `ehPadrao` fariam a resolução de "usuário sem assinatura" depender
da ordem de leitura.

Mesmo critério da migration `20260827_tv_pairing`, que ignorou de propósito um
item do diff por ser outra decisão, com outro risco.

### Rollback

Os arquivos `ROLLBACK.sql` ficam versionados ao lado de cada migration e **não
são executados por nada**. Ficam ali para que desfazer não dependa de alguém
reescrever o SQL sob pressão.

**Fase 1** (`20260910_planos_assinaturas/ROLLBACK.sql`) — o rollback real é
reverter o PR: nenhuma rota lê aquelas tabelas, então o aplicativo volta ao
estado anterior mesmo com elas presentes no banco.

**Fase 4** (`20260910_pedido_pagamento/ROLLBACK.sql`) — o rollback real é
**desligar a flag**: `BLACKCAT_PIX_ATIVO=false`, ou remover a variável. Com ela
desligada, `POST /api/billing/orders` recusa antes de qualquer coisa; é
instantâneo, não precisa de deploy e não perde nada. Reverter o PR é o segundo
passo. O arquivo só entra em cena se a tabela precisar sumir de fato, e ele
**recusa sozinho** se houver qualquer pedido ou qualquer assinatura ligada a
pedido — apagar aquela tabela apagaria o registro de quanto foi cobrado, de quem
e com qual transação no provedor, e isso não pode acontecer em silêncio. Ele
também derruba a FK explicitamente antes do `DROP TABLE`, em vez de usar
`CASCADE`: `DROP TABLE ... CASCADE` removeria a *constraint* e deixaria
`Assinatura.pedidoId` órfã sem avisar.

## Banco em Produção

- **Provider:** PostgreSQL (Supabase)
- `DATABASE_URL` — connection string pooler (PgBouncer) para Serverless
- `DIRECT_URL` — connection string direto para migrations (sem pooler)

Ambos necessários porque o pooler PgBouncer não suporta comandos DDL (necessários para `prisma migrate`).
