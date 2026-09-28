# Painel administrativo separado, fase 1

Estado: implementado na branch `feat/admin-obaflix-separado`, **sem** deploy,
sem migration em produção e sem cutover.

## Superfícies

- Projeto público: `OBAFLIX_SURFACE=public` e `NEXT_PUBLIC_OBAFLIX_SURFACE=public` (padrão quando ausentes).
- Projeto administrativo: `OBAFLIX_SURFACE=admin`, `NEXT_PUBLIC_OBAFLIX_SURFACE=admin` e `NEXTAUTH_URL` apontando para o domínio próprio do painel.
- `OBAFLIX_PUBLIC_ADMIN_CUTOVER=false` em ambos até a fase de cutover. Ligada no projeto público, `/admin` e `/api/admin/*` respondem 404; o resto do site não muda.
- Superfície admin:
  - `/` → 307 para `/admin`; `/admin` sem sessão → `/login`.
  - Streaming, cadastro (página e `/api/auth/cadastro`), conta, planos, sitemap e todas as APIs fora de `/api/admin`, `/api/auth` e `/api/integracoes` → 404.
  - Páginas são barradas pelo middleware. As APIs são barradas por rewrites de build em `next.config.mjs`, porque colocar `/api/*` inteiro no matcher cobraria uma invocação de middleware por requisição do player e dos apps.
  - `robots.txt` responde `Disallow: /`, e as páginas levam `noindex, nofollow`.
  - Login só aceita `role=admin` (credenciais e Google). Uma sessão sem admin vê "Acesso restrito" com botão de sair, sem laço de redirect.
  - `x-admin-token` é ignorado no painel inteiro.
- Superfície pública: comportamento atual preservado (mesmo `robots.txt`; `/admin` e `/api/admin/*` com o fluxo legado). O matcher do middleware ganhou apenas `/api/admin/:path*`, para o gate do cutover.

## Modelo de credenciais

| Credencial | Aceita em | Nunca aceita em |
|---|---|---|
| Sessão com `role=admin` **revalidado no banco** a cada requisição | todas as APIs admin | — |
| `x-admin-token` (`ADMIN_SECRET_TOKEN`, legado MegaFlix/scripts), só na superfície pública | catálogo legado (`filme`, `serie`, `episodio`, `import`, `stats` resumido, `pagamentos/revisoes` pré-existente) | usuários, reset de senha, assinaturas, pagamentos (lista), canais, sincronizações, auditoria (`requireAdminSession` responde 403) |
| `CATALOG_SYNC_TOKEN` (≥ 32 caracteres, comparação timing-safe, 120 req/min por IP) | só `/api/integracoes/catalogo/*` | qualquer `/api/admin/*` |

`/api/admin/stats` com token legado devolve só as contagens de catálogo e usuários que já devolvia. Assinaturas, cadastros por dia e telemetria ficam restritos à sessão.

Pendência conhecida: `/api/admin/pagamentos/revisoes` (pré-existente) continua aceitando o token legado, porque o runbook `docs/revisao-manual-pagamentos.md` depende disso. Retirar o token dessa rota fica para o cutover, junto da troca do runbook.

## Escrita de catálogo (compartilhada)

`src/lib/catalog-write.ts` atende `/api/admin/{filme,serie,episodio,episodio/bulk}` e `/api/integracoes/catalogo/*`.

- Campo ausente não altera nada, e `null` limpa. `""` conta como ausente para integrações; em texto, o editor humano (`emptyStringClears`) usa `""` para limpar. Número vazio nunca apaga.
- Uma lista de gêneros vazia não apaga os gêneros existentes.
- `background` sem valor e sem backdrop do TMDB não apaga o atual.
- Episódio é idempotente por `(serieId, temporada, numeroEp)`. Sem temporada informada, vale 1, como no bulk legado. Aliases legados (`urlBR`, `urlENG`, `nome`) usam o primeiro valor preenchido.
- Os campos inteiros são truncados, o que evita erro do Prisma com `"2021.9"`.

## Assinaturas

Transições: suspender (ATIVA → SUSPENSA); cancelar (ATIVA|SUSPENSA → CANCELADA); reativar (SUSPENSA → ATIVA, só dentro da vigência); conceder cortesia `origem=admin`, só sem assinatura ATIVA vigente. CANCELADA é terminal. `observacao` não é sobrescrita, porque o billing usa CANCELADA + `observacao` como marca de substituição por upgrade; o motivo vai para `AdminAudit`. A troca de status tem guarda de concorrência (`updateMany` condicionado ao status lido). `PedidoPagamento` nunca é tocado.

## Auditoria

`AdminAudit` registra `adminUserId`, `action`, `targetType`, `targetId`, `reason`, metadata sanitizada e `createdAt`. A sanitização aceita só escalares; descarta chaves com senha/hash/cookie/token/jwt/secret/url/stream/signed/authorization e qualquer valor com esquema de URL. A redefinição de senha audita sem metadata e nunca devolve senha nem hash.

## Telemetria de sincronização

`SyncRun` (nova) é alimentada por `POST /api/integracoes/catalogo/heartbeat`. **Nenhum produtor envia heartbeat ainda.** O painel mostra `sem telemetria` e não inventa execução. A única telemetria real hoje é a `SyncMetric` legada do popular-sync (`tmdb:popular-sync`), exibida em "TMDB Popular" como métrica legada; ela não distingue execução local de Vercel.

Atraso: com frequência conhecida, a fonte fica ATRASADA quando o último **sucesso** passa de 2× o intervalo (job de 5h → alerta após 10h sem sucesso). Uma fonte sem nenhuma telemetria não é marcada como atrasada.

Nomes de `source` reservados para o heartbeat (`src/lib/sync-sources.ts`): `megafrix-local`, `webcine-local`, `superflix-local`, `tmdb-popular`, `megafrix-vercel`, `tmdb-top250`, `megaflix-tampermonkey`, `importacao-manual`. Uma fonte fora dessa lista aparece como "fora do inventário".

Os resumos de erro são gravados e exibidos sem URL e sem `api_key=`/`token=`.

## Tarefa Windows observada (não alterada)

- Nome: `Obaflix - Sincronizar catalogos a cada 5 horas`; estado `Ready`; usuário `rmmic`, logon interativo, `RunLevel=Limited`; `MultipleInstances=IgnoreNew`; limite `PT4H30M`; repetição `PT5H`.
- Comando: `powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\streaming-app\scripts\run-local-syncs.ps1"`, diretório `D:\streaming-app`.
- Cadeia: `run-local-syncs.ps1` → `node node_modules\tsx\dist\cli.mjs scripts\run-local-syncs.ts`. O runner importa os route handlers **do checkout `D:\streaming-app`** e chama-os em processo (URL sintética `http://127.0.0.1`, `CRON_SECRET` aleatório por execução quando ausente). Jobs em sequência: `megafrix` → `popular-tmdb` → `webcine` → `superflix`. Há lock em `%LOCALAPPDATA%\Obaflix\sync\sync.lock`, e o código de saída é 1 se qualquer job falhar.
- `run-local-syncs.ps1`, `run-local-syncs.ts`, `install-local-sync-task.ps1` e a rota `sync-superflix` **não estão versionados** (existem só em `D:\streaming-app`, não em `origin/main`). `src/lib/cron/webcine.ts` também tem alteração local lá.
- Chrome/Chrome Shell/Chromium: **não participa**. Nenhum job abre navegador. O Chrome aparece só no fluxo Tampermonkey manual.
- Logs: `%LOCALAPPDATA%\Obaflix\sync\logs\sync-<ISO>.log`, com 39 arquivos desde 18/09/2026.
- Última execução (28/09/2026 12:19 BRT, `LastTaskResult=1`): 3 sucessos e 1 falha. `popular-tmdb` respondeu HTTP 500 `Duplicidade alta em filmes: 46/500` (guarda de qualidade do popular-sync recusou o lote); MegaFrix, WebCine e SuperFlix concluíram.
- Execução anterior (09:48 BRT, disparo manual/`StartWhenAvailable`): os 4 jobs falharam com `fetch failed`, falha de rede local.
- Histórico desde 18/09 (39 ciclos): megafrix 36 ok/3 falhas; webcine 37/2; superflix 36/3; **popular-tmdb 6/33**. O código 1 recorrente vem quase sempre do popular-tmdb (duplicidade alta, sobreposição filme/série, "poucos filmes retornados"). Isso é uma recusa por qualidade, não uma quebra do agendamento.

## Inventário de sincronizações

| FONTE | EXECUTA_ONDE | FREQUENCIA | SCRIPT | DESTINO_ATUAL | AUTENTICACAO | ESCREVE_O_QUE | TELEMETRIA_ATUAL |
|---|---|---|---|---|---|---|---|
| MegaFrix (`megafrix`) | Agendador do Windows, `D:\streaming-app` | 5h | `run-local-syncs.ps1` → `run-local-syncs.ts` → handler `/api/cron/sync` | PostgreSQL direto; lê `app.megafrixapi.com` e `megafrixapi.com/iptv` | `CRON_SECRET` interno; banco por `DATABASE_URL` | filmes, séries, animes, episódios; o handler também roda WebCine | só log local; sem `SyncRun` |
| TMDB Popular (`popular-tmdb`) | mesmo ciclo 5h | 5h | handler `/api/cron/popular-sync` | PostgreSQL direto + Redis | `CRON_SECRET` interno; `TMDB_API_KEY`/`TMDB_JWT` | ranking popular, stubs, `popularRank` | `SyncMetric` (`tmdb:popular-sync`) + log local |
| WebCine (`webcine`) | mesmo ciclo 5h | 5h | handler `/api/cron/sync-webcine` | PostgreSQL direto; lê `webcinevs2.com` | `CRON_SECRET` interno; `WEBCINE_REFRESH_TOKEN`/`DEVICE_ID`/`PROFILE_ID` | filmes, séries, animes, episódios; URLs WebCine | só log local |
| SuperFlix calendário (`superflix`) | mesmo ciclo 5h | 5h | handler local não versionado `/api/cron/sync-superflix` | PostgreSQL direto; lê calendário SuperFlix | `CRON_SECRET` interno | séries e episódios disponíveis | só log local |
| MegaFrix/Vercel | Vercel Cron do projeto público (`vercel.json` de `origin/main`) | diário 03:00 UTC | `/api/cron/sync` | PostgreSQL direto | `Authorization: Bearer CRON_SECRET` | igual ao MegaFrix local | nenhuma; execução em produção não verificada nesta fase |
| TMDB Popular/Vercel | Vercel Cron do projeto público | diário 03:30 UTC | `/api/cron/popular-sync` | PostgreSQL direto + Redis | `Bearer CRON_SECRET`; TMDB | ranking popular | `SyncMetric` (indistinguível do local) |
| Reconciliação de cobrança | Vercel Cron (só em `origin/main`) | diário 04:15 UTC | `/api/cron/billing-reconcile` | pedidos/revisões financeiras | `Bearer CRON_SECRET` | estados de pagamento; **não é catálogo** | nenhuma no painel |
| WebCine/Vercel avulso | rota existe, sem agendamento em `vercel.json` | sob demanda | `/api/cron/sync-webcine` | PostgreSQL direto | `Bearer CRON_SECRET` + credenciais WebCine | catálogo WebCine | nenhuma |
| Tampermonkey MegaFlix | Chrome do operador, `@match` no painel MegaFlix (`admin.megafrixapi.com`, que é **origem**) | manual, por ação interceptada | `scripts/tampermonkey-sync.js` | `https://obaflix.vercel.app/api/admin/{filme,serie,episodio/bulk}` | `x-admin-token` legado (CORS liberado só para `admin.megafrixapi.com`) | filme, série e episódios editados no MegaFlix | nenhuma |
| MegaFrix HTTP manual | terminal local | manual | `scripts/sync-app.ts` | `OBAFLIX_URL` (padrão `obaflix.vercel.app`) `/api/admin/*` | `ADMIN_SECRET_TOKEN` via `x-admin-token` | filmes, séries, episódios | nenhuma |
| MegaFlix banco direto | terminal local | manual | `scripts/sync-megaflix.ts` | PostgreSQL direto; lê `admin.megafrixapi.com` como **fonte** e TMDB | `DATABASE_URL`; `TMDB_API_KEY` | catálogo completo e episódios (`createMany`) | nenhuma |
| WebCine script | terminal local | manual | `scripts/sync-webcine.ts` | PostgreSQL direto; lê WebCine | `DATABASE_URL`; credenciais WebCine | filmes, séries, episódios | nenhuma |
| Importação JSON | terminal local | manual | `scripts/import.ts` | PostgreSQL direto | `DATABASE_URL` | filmes, séries, gêneros, episódios | nenhuma |
| Importação de episódios/TMDB | terminal local | manual | `scripts/import-episodes.mjs` | PostgreSQL direto; TMDB | `DATABASE_URL` + `TMDB_API_KEY` | episódios e thumbnails | nenhuma |
| EmbedMovies | terminal local | manual | `scripts/import-embedmovies.mjs` | PostgreSQL direto; lê embedmovies + TMDB | `DATABASE_URL` + `TMDB_API_KEY` | séries e gêneros (upsert) | nenhuma |
| Top 250 | terminal local e botão do painel | manual | `scripts/reorganize-top250.ts`; `/api/admin/sync-top250` | PostgreSQL direto; TMDB | `DATABASE_URL`/TMDB; painel por sessão admin (ou token legado) | `top250`, criação de títulos ausentes | nenhuma |
| Backfill de arte/scores/logos | terminal local e painel | manual | `scripts/backfill-arte.ts`, `scripts/backfill-scores.ts`, `/api/admin/backfill-logos` | PostgreSQL direto; TMDB | `DATABASE_URL`/TMDB; painel por sessão | logo, background, scores | nenhuma |
| Importação manual do painel | painel humano | manual | `/api/admin/import` | PostgreSQL direto | sessão admin (ou token legado) | upserts de catálogo | nenhuma |
| Canais | terminal local | manual | `scripts/importar-canais.ts`, `scripts/canais-curadoria.ts` | PostgreSQL direto | `DATABASE_URL` | `Canal`, `CanalFonte` | nenhuma |
| Limpeza de duplicados | terminal local | manual | `scripts/cleanup-dupes.ts` | `OBAFLIX_URL` `/api/admin/serie` | `ADMIN_SECRET_TOKEN` | remove séries duplicadas | nenhuma |

## Cutover posterior

Pendência deliberada: esta fase não adiciona a flag de "troca obrigatória de senha". O schema e a autenticação atuais não têm esse estado, e improvisá-lo apenas na UI não seria enforcement. A senha temporária tem mínimo de 12 caracteres, motivo obrigatório, confirmação e auditoria; a troca forçada deve entrar em fase própria, com migration e bloqueio no servidor.

1. Criar o segundo projeto Vercel com `OBAFLIX_SURFACE=admin`, `NEXT_PUBLIC_OBAFLIX_SURFACE=admin`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, banco e Upstash compartilhados. No projeto admin, os crons do `vercel.json` respondem 404, então não duplicam as execuções.
2. Aplicar a migration aditiva `20260928150000_admin_surface_observability` em janela controlada; testar login, role e painel.
3. Versionar os scripts locais (`run-local-syncs.*`, `sync-superflix`) e trocar cada produtor HTTP para `/api/integracoes/catalogo/*` com `CATALOG_SYNC_TOKEN` e heartbeat de início e fim.
4. Observar ao menos um ciclo real de 5h e os crons, comparando contagens, duplicatas e erros.
5. Só então ligar `OBAFLIX_PUBLIC_ADMIN_CUTOVER=true` no projeto público e retirar o token legado de `pagamentos/revisoes`.
