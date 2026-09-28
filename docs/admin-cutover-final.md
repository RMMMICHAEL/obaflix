# Admin separado — estado final do cutover

Continuação de `docs/admin-separado-fase-1.md`. Este documento descreve o que
o código faz depois desta fase e o que **ainda depende de ação externa**. Tudo
aqui foi feito e testado no repositório; nada foi aplicado em Vercel,
Supabase, Upstash ou no Windows do operador.

## 1. Arquitetura

| Superfície | Projeto | O que responde |
|---|---|---|
| **Pública** (`OBAFLIX_SURFACE=public`) | projeto Vercel atual | site, apps, player, crons, `/api/integracoes/catalogo/*`. `/admin` e `/api/admin/*` só enquanto `PUBLIC_CUTOVER_ATIVO` estiver desligado |
| **Admin** (`OBAFLIX_SURFACE=admin`) | segundo projeto Vercel, domínio próprio | `/` → `/admin`; `/login`; `/api/auth/*` (sem cadastro); `/api/admin/*`; `/api/integracoes/*`. Todo o resto 404; `robots.txt` `Disallow: /`; `noindex` |
| **Integrações** | qualquer superfície | `/api/integracoes/catalogo/{filme,serie,episodios/bulk,consulta,heartbeat}` com `CATALOG_SYNC_TOKEN`. Não passam por `/api/admin` nem pelo cutover |

Electron e Android não consomem `/api/admin`, `/api/integracoes` nem
`/api/player/debug-segment` (conferido em `desktop/electron/*` e `android/`).
Os três ambientes leem o mesmo catálogo, então dedupe e índice único valem
igual para os três sem mudança de cliente.

## 2. Autenticação

| Credencial | Guarda | Aceita em | Nunca aceita em |
|---|---|---|---|
| Sessão com `role=admin` **reconfirmado no banco** a cada requisição | `requireAdmin` = `requireAdminSession`; `requireAdminAction` (+ origem = host, rate limit por admin, `AdminAudit`) | todas as APIs admin | — |
| `x-admin-token` (`ADMIN_SECRET_TOKEN`) | `requireAdminOrLegacyCatalogToken` | **só** `GET`/`POST` em `/api/admin/{filme,serie,episodio/bulk}`, superfície pública, cutover desligado, segredo ≥ 32 | usuários, reset de senha, assinaturas, pagamentos, **revisões de pagamento**, canais, auditoria, sincronizações, stats, import, top250, backfill, tmdb-search, security-metrics, debug-segment, qualquer `DELETE`/`PUT`. Em API humana o header leva 403 **sem consultar sessão** |
| `CATALOG_SYNC_TOKEN` (Bearer ou `x-catalog-sync-token`, timing-safe, ≥ 32, 120 req/min por IP) | `requireCatalogSync` | só `/api/integracoes/catalogo/*` | qualquer `/api/admin/*` e todo dado humano |

A página `/admin` exige JWT com `role=admin` no middleware; nenhum cabeçalho
substitui a sessão ali (o atalho antigo do `x-admin-token` no `authorized` foi
removido — era inofensivo, mas enganoso). Cada API chamada pela página
reconfirma o papel no banco.

Escrita pelo token legado passa a usar a mesma semântica de máquina da
integração (`CATALOG_WRITE_MAQUINA`): o Tampermonkey em modo legado manda
`null` no que não tem e `tipo: "serie"` sempre, e antes disso **apagava**
sinopse/URLs e **rebaixava anime/desenho para série**.

### Matriz de consumidores

| ARQUIVO | FUNÇÃO | ENDPOINT ATUAL | AUTH | MIGRAR? | DESTINO |
|---|---|---|---|---|---|
| `scripts/tampermonkey-sync.js` (v1.2) | duplica add/edit do painel MegaFlix | integração se `obaflixCatalogToken` existe; senão `/api/admin/{filme,serie,episodio/bulk}` | Bearer `CATALOG_SYNC_TOKEN`; legado `x-admin-token` com aviso | sim — **feito**, legado só como fallback de transição | `/api/integracoes/catalogo/*` |
| `scripts/sync-app.ts` | MegaFlix App → Obaflix, manual | integração se `CATALOG_SYNC_TOKEN` existe; `OBAFLIX_SYNC_DESTINO=legado` força o legado | idem | sim — **feito**; `--init` agora funciona na integração (via `consulta`) | `/api/integracoes/catalogo/*` |
| `scripts/cleanup-dupes.ts` | remove séries duplicadas por título | **banco direto** (antes: HTTP `/api/admin/serie` + DELETE com token) | `DATABASE_URL` | sim — **feito**, dry-run padrão, `--apply` explícito | manutenção controlada |
| `scripts/run-local-syncs.ts` | ciclo 5h local | handlers em processo; heartbeat `db` ou `http` | `DATABASE_URL`; `http` usa `CATALOG_SYNC_TOKEN` | não | — |
| `src/app/admin/page.tsx` | painel | `/api/admin/*` | sessão (sem header de token) | não | — |
| `docs/revisao-manual-pagamentos.md` | runbook de revisão | `/api/admin/pagamentos/revisoes*` | antes `x-admin-token`; agora **sessão** | sim — **feito** | console do navegador na sessão do painel |
| `scripts/sync-megaflix.ts` | import direto | lê `admin.megafrixapi.com` como **fonte** | `DATABASE_URL` | não (não é Admin Obaflix) | — |
| `src/middleware.ts`, `src/lib/auth.ts` | CORS legado | origem `https://admin.megafrixapi.com` | — | reduzido a GET/POST/OPTIONS nas 3 rotas de catálogo | some com o cutover |
| Electron `main.js`, Android `gradle.properties` | apps | `obaflix.vercel.app` / `obaflix.online` (player, não admin) | — | não | — |

`admin.megafrixapi.com` aparece só como **origem** MegaFlix (match do
userscript, CORS legado e fonte de `sync-megaflix.ts`). Não é o admin do Obaflix.

## 3. Variáveis

| Variável | Público | Admin | Observação |
|---|---|---|---|
| `OBAFLIX_SURFACE`, `NEXT_PUBLIC_OBAFLIX_SURFACE` | `public` | `admin` | a `NEXT_PUBLIC` é compilada: mudar exige novo build |
| `PUBLIC_CUTOVER_ATIVO` | `0` → `1` no cutover | irrelevante | padrão desligado. `OBAFLIX_PUBLIC_ADMIN_CUTOVER` (fase 1) ainda aceito; `PUBLIC_CUTOVER_ATIVO` vence |
| `CATALOG_SYNC_TOKEN` | sim, se produtores escrevem no público | sim, se escrevem no admin | o mesmo valor no deploy que o produtor chama e no produtor |
| `ADMIN_SECRET_TOKEN` | só na transição | **não configurar** | ausente = legado desligado |
| `NEXTAUTH_URL` | domínio público | domínio do painel | |
| `NEXTAUTH_SECRET` | | | segredo próprio por projeto é o mais seguro (sessão de um não vale no outro) |
| `DATABASE_URL`, `DIRECT_URL` | | | mesmo banco |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | | **obrigatório** no admin | rate limit do login, do token de catálogo e das ações admin; sem Redis cai em memória por instância |

## 4. Como ativar a integração (produtores)

1. Gerar um valor: `openssl rand -base64 48`.
2. Configurar `CATALOG_SYNC_TOKEN` no projeto Vercel que o produtor chama (hoje
   o público, `OBAFLIX_URL` padrão) e fazer redeploy.
3. Conferir sem escrever nada:
   `curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $CATALOG_SYNC_TOKEN" -H "content-type: application/json" -d '{"filmes":[],"series":[]}' https://<projeto>/api/integracoes/catalogo/consulta`
   → `200`. Sem token → `403`.
4. `sync-app`: exportar `CATALOG_SYNC_TOKEN` no terminal local; o modo passa a
   integração sozinho (sem `OBAFLIX_SYNC_DESTINO`). `npx tsx scripts/sync-app.ts --init` repopula a memória pela integração.
5. Tampermonkey: atualizar para a v1.2 e, no console do painel MegaFlix,
   `GM_setValue('obaflixCatalogToken', '<valor>')` (ou `localStorage.setItem`).
   O console mostra `Ativo (modo integracao)`.
6. Runner local: opcional `SYNC_TELEMETRY=http` + `OBAFLIX_INTEGRACAO_URL`; o
   padrão `db` não precisa do token.

## 5. Como ativar o cutover

Pré-requisitos: seção 4 concluída; nenhum `x-admin-token` nos logs da Vercel
por pelo menos um ciclo de 5h; projeto admin no ar e login testado.

1. Projeto **público**: `PUBLIC_CUTOVER_ATIVO=1` e redeploy (o middleware lê em
   runtime, mas a Vercel só aplica variável nova em deploy novo).
2. Verificar: `/admin`, `/admin/x`, `/api/admin/usuarios`, `/api/admin/filme` → **404**; `/`, `/login`, `/api/integracoes/catalogo/consulta` (com token) → como antes.
3. Remover `ADMIN_SECRET_TOKEN` dos dois projetos.

Rollback do cutover: `PUBLIC_CUTOVER_ATIVO=0` + redeploy. Nada no banco muda.

## 6. Episódios duplicados

**Causa raiz (confirmada no código):** o schema declara
`@@unique([serieId, temporada, numeroEp])`, mas o índice nunca foi criado no
banco (`scripts/verificar-tv-tabelas.ts` espera "ausente"). Os produtores em
lote usavam `createMany({ skipDuplicates: true })`, que só pula quando o banco
recusa — logo só pulava conflito de **ID**. O mesmo episódio com IDs
diferentes (`wc_ep_560647` do `sync-webcine.ts`, `sf_<tmdb>-t1e1` do SuperFlix,
ID numérico do MegaFlix) virava segunda linha. A quantidade atual em produção
**não foi medida** (sem acesso ao banco).

**Correção no código:**
- `src/lib/episode-coordinate.ts` (`writeEpisodesByCoordinate`): consulta a
  coordenada antes de inserir; coordenada existente nunca vira INSERT, só
  completa campos vazios; repetição no mesmo lote vira uma linha. Uma leitura
  indexada extra por lote de 200. Usado por SuperFlix (3 pontos),
  `sync-webcine.ts`, `import.ts`, `sync-megaflix.ts`; `import-episodes.mjs`
  filtra pela coordenada da série; o cron WebCine já comparava coordenadas e
  agora também deduplica dentro da resposta.
- `catalog-write.ts` (painel, token legado, integração): `findFirst` pela
  coordenada (ordem `createdAt, id`) + `update`/`create`. **Não usa `upsert`
  na chave composta**: sem o índice no banco o `ON CONFLICT` do upsert nativo
  falharia. Com o índice, corrida no `create` (P2002) vira update.
- MegaFlix cron (`/api/cron/sync`) já fazia `findFirst` pela coordenada.

### Dedupe (`scripts/dedupe-episodios.ts`, lógica em `src/lib/episode-dedupe.ts`)

```
npx tsx scripts/dedupe-episodios.ts                                   # DRY RUN (padrão)
npx tsx scripts/dedupe-episodios.ts --apply --backup-dir D:\obaflix-backups
```

- Canônico: referenciado por WatchHistory → mais metadata válida (urlDub,
  urlLeg, título real, thumbnail) → ID `<serieId>-t<T>e<E>` → `createdAt` → `id`.
- Merge: campos vazios do canônico recebem o valor da duplicata; título
  "Episódio N" é tratado como vazio; espelhos de URL (lista por vírgula) são
  somados sem perder nenhum; valor válido nunca vira null. Divergência de
  título/thumbnail vira "conflito" no relatório (fica a do canônico).
- WatchHistory (única FK para `Episodio`): movido para o canônico. Se o mesmo
  usuário tiver progresso nas duas linhas (o único `userId, conteudoId,
  episodioId` impediria mover), fica o registro mais recente e ele herda
  `concluido`.
- Dry-run informa grupos, linhas, canônicos, removíveis, FKs a mover, históricos
  a mesclar, campos a mesclar, conflitos e erros. Não escreve nada.
- Apply: exige `--backup-dir` (fora do repositório, ou em `backups/`, que o
  `.gitignore` exclui); grava o JSON das linhas afetadas **antes** da primeira
  escrita; cada grupo numa transação com invariantes (uma linha por
  coordenada, nenhum WatchHistory órfão, nenhum campo válido apagado, merge
  gravado); a primeira falha desfaz o grupo e interrompe a execução (código 1).
  Grupo que mudou entre o plano e a execução não é tocado.

### Índice único (`prisma/migrations/20260930120000_episodio_unique_coordenada`)

`migration.sql` falha com `RAISE EXCEPTION` se houver duplicata e só então
cria `Episodio_serieId_temporada_numeroEp_key` (nome que o Prisma gera),
`IF NOT EXISTS`, em `BEGIN/COMMIT`, com `lock_timeout` de 10 s. Bloqueia
escritas em `Episodio` durante a construção (segundos); leituras seguem.
`VERIFICACAO.sql` (somente leitura) tem o bloco A (antes) e B (depois);
`ROLLBACK.sql` só remove o índice. Nada de `prisma db push`.

Ordem obrigatória:

1. backup do banco (Supabase → Database → Backups, ou `pg_dump` da tabela `Episodio` e `WatchHistory`);
2. `dedupe-episodios.ts` (dry-run) e revisar o relatório;
3. `dedupe-episodios.ts --apply --backup-dir <dir>`;
4. `VERIFICACAO.sql` bloco A → zero duplicatas, zero órfãos;
5. aplicar `migration.sql` (SQL Editor do Supabase ou `psql "$DIRECT_URL" -f`);
6. `VERIFICACAO.sql` bloco B;
7. smoke: bloco B3 (comentado) numa série de teste, ou rodar um produtor e
   confirmar que o contador de episódios não cresce na reexecução.

Rollback: `ROLLBACK.sql` desfaz o índice; o dedupe se desfaz a partir do JSON
de backup (reinserir linhas e reapontar WatchHistory) — por isso o backup é
obrigatório.

## 7. Telemetria

`source` estáveis (`src/lib/sync-sources.ts`): `megaflix-local`,
`tmdb-popular-local`, `webcine-local`, `superflix-local` (runner local) e
`megaflix-vercel`, `tmdb-popular-vercel`, `webcine-vercel`, `superflix-vercel`
(`withCronTelemetry`). Nomes conferidos entre runner, handlers e painel; esta
fase não os alterou. O Tampermonkey não envia heartbeat (um SyncRun por edição
manual seria ruído); `sync-app` é manual e também não envia.

Não verificado daqui: `LastTaskResult`, próxima execução, estado do
Agendador, caminho efetivo do checkout no Windows e se a migration
`20260928150000`/`20260929120000` já existe em produção.

## 8. Segurança (revisão desta fase)

- **Revisado:** todas as rotas em `src/app/api/admin/**`, `/api/integracoes/**`,
  `/api/player/debug-segment`, middleware, `auth.ts`, `admin-action.ts`
  (auditoria), produtores em `scripts/`, `.env.example`, docs, diff completo.
- **Riscos encontrados e mitigados:**
  - token estático universal abria API humana (import, stats, top250, backfill,
    tmdb-search, security-metrics, debug-segment — este último busca URL
    arbitrária do servidor) e **ação financeira** (revisões de pagamento, com
    ator anônimo `token_admin`) → agora só sessão admin com papel no banco;
  - token legado podia `PUT`/`DELETE` catálogo → só `GET`/`POST` e só nas 3
    rotas de catálogo; `cleanup-dupes` saiu do HTTP;
  - escrita pelo token legado apagava campos e rebaixava anime → semântica de máquina;
  - CORS legado anunciava `PUT, DELETE` → `GET, POST, OPTIONS`, nunca no painel ou após cutover;
  - backup do dedupe contém dados de produção → recusado dentro do repo fora de `backups/` (gitignored), arquivo `0600`.
- **Sem mudança (já estava correto):** auditoria sanitizada (sem senha, hash,
  JWT, cookie, secret, URL, stream); erros de integração sem stack; token de
  catálogo com escopo por caminho, timing-safe e rate limit; `consulta`
  devolve só identidade/contagem.
- Nenhum segredo, `.env` real ou token em fixture (fixtures usam `"a".repeat(48)`).

## 9. Limitações desta execução (Cloud)

Sem acesso a Vercel, Supabase, Upstash, Windows/Agendador, Chrome local ou
`.env` do operador. Um Postgres local para testar migration e dedupe não pôde
ser provisionado no container (permissão negada), então dedupe e migration
foram provados com banco em memória que simula transação/rollback, único de
WatchHistory e FK, e com verificação estática do SQL — **não** contra um
Postgres real.

## AÇÕES EXTERNAS APÓS O MERGE

`ACAO_EXTERNA_PENDENTE` — nada disto foi executado:

1. **Vercel público:** confirmar que o deploy do `main` subiu; `PUBLIC_CUTOVER_ATIVO` **ausente ou `0`**. Conferir que `/api/admin/usuarios` com `x-admin-token` agora dá 403 e o painel continua funcionando por sessão.
2. **Vercel público:** configurar `CATALOG_SYNC_TOKEN` (≥ 32) e redeploy; testar `consulta` (seção 4, passo 3).
3. **Vercel admin:** conferir `OBAFLIX_SURFACE=admin`, `NEXT_PUBLIC_OBAFLIX_SURFACE=admin`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, banco e **Upstash** (`UPSTASH_REDIS_REST_URL`/`TOKEN`) — sem `ADMIN_SECRET_TOKEN`.
4. **Login manual** com a conta admin no domínio do painel: `/` → `/admin`, abas carregam; conta sem admin vê "Acesso restrito"; `/filmes` → 404; `/robots.txt` → `Disallow: /`.
5. **Supabase:** confirmar se `20260928150000_admin_surface_observability` e `20260929120000_sync_run_found` já estão aplicadas (`VERIFICACAO.sql` delas); aplicar se não.
6. **Supabase:** executar a ordem da seção 6 (backup → dedupe dry-run → apply → verificação A → migration → verificação B → smoke). Rodar o dedupe de uma máquina com `DATABASE_URL` de produção, nunca pelo Cloud.
7. **PC do operador:** atualizar o checkout usado pela tarefa (`D:\streaming-app` ou o novo) para o `main`; `npm ci`, `npx prisma generate`, `npm run sync:local:check`.
8. **PC do operador:** Tampermonkey v1.2 + `obaflixCatalogToken`; `sync-app` com `CATALOG_SYNC_TOKEN` no ambiente local.
9. **Observar um ciclo real de 5h:** `LastTaskResult` 0 ou 2; 4 `SyncRun *-local` no painel; contagem de episódios estável em reexecução.
10. **Cutover:** só depois de 1–9, `PUBLIC_CUTOVER_ATIVO=1` no público + redeploy; verificar os 404 (seção 5); remover `ADMIN_SECRET_TOKEN` dos dois projetos.
