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
| `filmes` / `series` | `Boolean @default(true)` | |
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
| `pedidoId` | `String? @unique` | Trava de idempotência: um pedido ativa no máximo uma assinatura. **Sem FK ainda** — `PedidoPagamento` não existe |
| `observacao` | `String?` | Anotação de suporte. Nunca dado de pagamento, nunca documento |

### Domínio dos campos de texto

`canaisNivel`, `resolucaoMax`, `tvNivel`, `status` e `origem` são `String` com
`CHECK` no banco, não `enum` nativo. Motivo: `ALTER TYPE ... ADD VALUE` não roda
dentro de transação no Postgres, então acrescentar um nível viraria migration com
janela. `CHECK` valida igual e muda numa linha.

Os valores aceitos vivem em dois lugares — as constantes de `src/lib/planos.ts` e
os `CHECK` da migration. `src/lib/__tests__/planos.test.ts` lê os dois arquivos e
falha se divergirem.

### Seed do plano padrão

```bash
npm run seed:planos          # dry-run, só mostra o que faria
npm run seed:planos:apply    # grava
```

Idempotente por `upsert` no id. Cria **apenas** o plano Gratuito, e **nenhuma**
linha de `Assinatura`.

Os valores semeados são uma **fotografia do comportamento atual** do Obaflix, não
a matriz comercial: sem anúncio, com download, 4K, TV completa e `telasMax = 5`
(o `MAX_CONCURRENT` de hoje). É assim que a migration não muda o comportamento de
nenhum usuário. Restringir o gratuito é editar `PLANO_GRATUITO` e rodar o seed —
não é um deploy.

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

`prisma/migrations/20260910_planos_assinaturas/ROLLBACK.sql` fica versionado e
**não é executado por nada**. O rollback real da Fase 1 é reverter o PR: nenhuma
rota lê estas tabelas, então o aplicativo volta ao estado anterior mesmo com elas
presentes no banco.

## Banco em Produção

- **Provider:** PostgreSQL (Supabase)
- `DATABASE_URL` — connection string pooler (PgBouncer) para Serverless
- `DIRECT_URL` — connection string direto para migrations (sem pooler)

Ambos necessários porque o pooler PgBouncer não suporta comandos DDL (necessários para `prisma migrate`).
