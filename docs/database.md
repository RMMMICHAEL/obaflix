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

## Banco em Produção

- **Provider:** PostgreSQL (Supabase)
- `DATABASE_URL` — connection string pooler (PgBouncer) para Serverless
- `DIRECT_URL` — connection string direto para migrations (sem pooler)

Ambos necessários porque o pooler PgBouncer não suporta comandos DDL (necessários para `prisma migrate`).
