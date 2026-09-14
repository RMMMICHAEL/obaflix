# Ambiente isolado de testes — resultado da criação

Executado em 2026-09-14, com autorização explícita para os itens 1, 2 e 3,
**exclusivamente no ambiente isolado**. Nenhum segredo neste documento.

## 1. Recursos criados

| Recurso | Identificação | Isolamento |
|---|---|---|
| Postgres | Neon `obaflix-teste-db` (plano `free_v3`), banco `neondb`, Postgres 18.6 | criado vazio; ligado ao projeto só em **Preview** com prefixo `OBAFLIX_TESTE_` (nenhum código lê esse prefixo) |
| Redis | Upstash `obaflix-teste-redis` (produto `upstash-kv`, plano `free`) | criado vazio (0 chaves); mesmo prefixo, só Preview |
| Worker | `obaflix-media-teste` em `https://obaflix-media-teste.obacanal.workers.dev` | nome próprio; segredos próprios; Redis de teste; `APP_ORIGIN` = Preview da branch; listas de hosts vazias (recusa tudo) |
| Preview | branch `feat/tv-planos-promocao` → `https://obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app` | variáveis com escopo **Preview restrito à branch**, sobrepondo só nesta branch as entradas compartilhadas com Production |
| Marcador | `_ObaflixAmbiente.id = 622c47cd-6a04-40d7-a29f-0683be63ef5b` | conferido antes de cada escrita |

Variáveis da branch (valores não listados): `DATABASE_URL`, `DIRECT_URL`,
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `NEXTAUTH_SECRET`,
`ADMIN_SECRET_TOKEN`, `CRON_SECRET`, `BLACKCAT_WEBHOOK_PATH_SECRET`,
`TESTE_PAGAMENTO_TOKEN`, `CANAIS_MEDIA_BASE`, `CANAIS_MEDIA_SIGNING_SECRET`,
`MONETIZACAO_ATIVA=true`, `BLACKCAT_PIX_ATIVO=true`,
`BLACKCAT_CONFIRMACAO_ATIVA=true`, `PAGAMENTO_SIMULADO=true`,
`OBAFLIX_AMBIENTE=teste`, `OBAFLIX_AMBIENTE_ID`. Nenhuma credencial Blackcat
real no Preview.

## 2. Validações

| # | Validação | Resultado |
|---|---|---|
| 1 | Banco novo vazio antes de escrever | ✅ Neon, 0 tabelas, sem marcador |
| 2 | Redis novo vazio antes de escrever | ✅ Upstash, 0 chaves |
| 3 | Marcador gravado e conferido | ✅ id certo aceito; id errado **recusado** (código 3) |
| 4 | Variáveis de Production intactas depois de cada alteração | ✅ as 23 entradas com Production idênticas; novas só em `Preview (feat/tv-planos-promocao)` |
| 5 | Schema: base Prisma + 10 migrations + tabelas de revisão | ✅ 26 tabelas; pré-verificação do marcador antes do conjunto |
| 6 | Verificação estrutural | ✅ 14 colunas da 20260913, 10 CHECKs, índice parcial de adicionais, revisão com índice parcial, chave única e trigger imutável, RLS ligado |
| 7 | Provedor simulado só no banco de teste | ✅ CHECK `blackcat, simulado` aqui; Production não tocado |
| 8 | Planos (dry-run → apply) | ✅ 4 planos: Gratuito (padrão), Básico, Plus e Premium (VIP incluso nos dois últimos) |
| 9 | Preços (dry-run sem conflito → apply com host de teste) | ✅ 9 preços; telas 10,00 / 9,95 / 14,95; VIP avulso 5,90 inativo |
| 10 | Preview lê o banco isolado | ✅ `/api/billing/plans` devolve os 4 planos com preços — Production não tem preço ativo |
| 11 | Preview grava no Redis isolado | ✅ `POST /api/tv/pair/start` → 200; Redis de teste 0 → 2 chaves |
| 12 | QR da TV aponta para o ambiente isolado | ✅ `urlVerificacao`/`urlQrCode` no host do Preview da branch |
| 13 | Rotas sensíveis | ✅ consulta admin sem autenticação → 401; pagamento simulado sem token → 404 |
| 14 | Contas fictícias | ✅ 4 contas `@teste.obaflix.invalid`; verificação do banco aceita (nenhum usuário fora do domínio) |
| 15 | APK de homologação | ✅ ver §4 |

### Diferenças necessárias no banco de teste (Production não muda)

- Papéis `anon`, `authenticated` e `postgres` criados sem login
  (`00-papeis-supabase-teste.sql`): as migrations citam papéis do Supabase.
- `20260812` aplicada pela cópia `05-...sql`, **sem** os três
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` — o Neon recusa ("permission
  denied to change default privileges") e eles só protegem a Data API do
  Supabase. REVOKEs e RLS idênticos.
- Base do schema gerada por `prisma migrate diff --from-empty`, sem
  `EventoPagamento` e tabelas de revisão, que as migrations/scripts criam com
  CHECKs, índices parciais e trigger.

## 3. Acesso da TV — Deployment Protection Exception

O Preview responde `302` para `vercel.com/sso-api` (Vercel Authentication), e o
APK da TV não tem sessão da Vercel. Decisão: **Deployment Protection Exception
somente para `obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app`**,
durante o smoke. Nenhum segredo de bypass no APK.

### 3.1 Antes de abrir

- Senhas das quatro contas fictícias **regeneradas** (as anteriores tinham sido
  expostas). As novas ficam só num arquivo local fora do repositório; nunca em
  documento versionado nem em mensagem.
- Linha de base: `obaflix.online` `/` e `/api/billing/plans` → 200, hash da API
  de planos `49D8A909AF79C642583ADFA1374974D557DDB9B5682C1FD50FF21D2E6D433E30`;
  domínio da homologação e Preview do #28 → 302.

### 3.2 Exceção criada

`PATCH /aliases/{uid}/protection-bypass` com
`{"override":{"scope":"alias-protection-override","action":"create"}}`, no
alias do domínio acima (id conferido com o projeto). Resposta:
`protectionBypass` com escopo `alias-protection-override`. Nenhum segredo
retornado ou usado.

### 3.3 Validações com a exceção ativa

| Validação | Resultado |
|---|---|
| Domínio da homologação sem login da Vercel | ✅ `/` → 200; `/api/billing/plans` → 200 |
| Outros Previews continuam protegidos | ✅ Preview do #28, URL própria de deploy da mesma branch e Preview antigo → 302 para `vercel.com/sso-api` |
| `obaflix.online` inalterado | ✅ mesmos status e cabeçalhos; hash da API de planos idêntico ao da linha de base |
| Banco isolado | ✅ domínio público devolve 4 planos e 9 preços (Production tem 0) |
| Redis isolado | ✅ `POST /api/tv/pair/start` → 200; Redis de teste 1 → 2 chaves; QR no domínio da homologação |
| Worker de teste | ✅ requisição sem assinatura → 403; `CANAIS_MEDIA_BASE` só no escopo da branch |
| Pagamento simulado e admin | ✅ simulado sem token → 404; admin sem autenticação → 401; nenhuma credencial Blackcat real no Preview |

### 3.4 Remoção depois do smoke

Mesmo endpoint, com `"action":"revoke"`. Validar em seguida: domínio da
homologação volta a responder 302 para `vercel.com/sso-api`, outros Previews
seguem 302 e `obaflix.online` mantém o hash da linha de base.

## 4. APK de homologação

### 4.1 APK reprovado no smoke (não usar)

SHA-256 `4EE8A7123B4954AE0F090613B5C2A9C31082A348E94E7BB0298410CD46DB6E5D`.
Crash poucos segundos após restaurar a sessão
(`IllegalArgumentException: Expected URL scheme 'http' or 'https' but no scheme was found for`),
causado pela URL de manifesto de atualização vazia da variante chegando ao
OkHttp. Diagnóstico, retrace e correção: `docs/tv-login-persistente.md` §6.1
(PR #29, commit `aa064ba`).

### 4.2 APK atual

| Item | Valor |
|---|---|
| Arquivo | `D:\obaflix-tv-planos\android\tv\build\outputs\apk\homologacao\tv-homologacao.apk` |
| Origem | branch `feat/tv-planos-promocao`, commit `5aa50bf` (inclui a correção do #29) |
| Pacote / versão | `com.obaflix.tv.homologacao` / `0.7.25-homologacao` (versionCode 41) |
| Certificado | `CN=Obaflix, OU=Mobile, O=Obaflix, C=BR`, SHA-256 `bdf64ebf3cc9f841a05d4a60d67c39bc957f69c0f4fd6b66c0465901f6a0de04` (aceito) |
| SHA-256 do APK | `B2333574876C93F5DE31285B417F009456E992E038DE9A647625954C92AEF65F` |
| URL embutida | só `https://obaflix-git-feat-tv-planos-promocao-michaeltrader.vercel.app` |
| Conferência do `dex` | URL de teste presente; `obaflix.online` ausente; guarda da URL de manifesto presente |
| Testes antes do build | `core-extractor` 22/22; TV `debug` 98/98; TV `homologacao` 102/102 (inclui `ConfiguracaoHomologacaoTest`) |

Correção feita no caminho: o `core-extractor` também ganhou a variante
`homologacao`. Antes, o APK de teste levava o domínio de Production no
`BuildConfig` do core (base do WebView do desafio, `Referer` do extrator, host
aceito no player).

**Não é release e não deve ser publicado.**

## 4.3 Home vazia no smoke — catálogo ausente no banco isolado

**Sintoma:** com o APK novo, a Home abria só o layout, sem filmes nem séries;
sem crash e sem erro HTTP no log.

**Causa:** o preparo do ambiente criou schema, marcador, planos, preços e
contas, mas **nenhum catálogo**. Contagem no banco de teste antes do ajuste:
`Filme 0`, `Serie 0`, `Episodio 0`, `Genero 0`, `Saga 0`, `Canal 0`.

**Rotas da Home da TV** (`/api/tv/home`, pública, só lê o banco) e dos
catálogos, comparadas por status e contagem, sem copiar conteúdo:

| Rota | Preview isolado (antes) | Production |
|---|---|---|
| `/api/tv/home` | 200, todas as fileiras com 0, 0 categorias | 200, 20 em alta, 24 por fileira, Top 10 com 10, 8 categorias |
| `/api/filmes?page=1&ordem=recente` | 200, 0 itens | 200, 24 itens, 1068 páginas |
| `/api/series?tipo=serie&page=1&ordem=recente` | 200, 0 itens | 200, 24 itens, 359 páginas |

**Ajuste (só no banco isolado):** `scripts/ambiente-teste/catalogo-minimo.ts`,
com verificação do marcador. Copia 8 filmes populares e as 4 primeiras séries
populares **que têm episódios**, com até 5 episódios da menor temporada de cada
uma, a partir das **APIs públicas** de catálogo e com lista fechada de campos
(ids, `tmdbId`/`imdbId`, título, artes do TMDB, sinopse, ano, nota,
popularidade, gêneros). `urlDub`/`urlLeg` ficam **nulos**: nenhuma URL de
provedor é gravada (as APIs públicas nem as expõem). O script é idempotente e
remove do banco de teste as séries que ele mesmo gravou sem episódio.

Na primeira execução, duas séries populares (`tmdb_94722` e `tmdb_91759`)
entraram sem episódios: em Production elas também têm **0** episódios na rota
pública. Foram substituídas por séries com episódios e removidas do banco de
teste.

**Depois:** `Filme 8`, `Serie 4`, `Episodio 20` (5 por série), `Genero 13`.
`/api/tv/home` → 12 em alta, 8 filmes por fileira, 4 séries por fileira, 7
categorias.

**Limites conhecidos do catálogo mínimo:**

- "Mais bem avaliados" fica vazio (a vitrine exige URL de provedor no banco);
- episódios aparecem como indisponíveis na TV (a disponibilidade vem de
  `urlDub`/`urlLeg`);
- filmes podem ter fontes pelo id e pelo `tmdbId` (a rota de fontes consulta
  também fontes externas e montadas por `tmdbId`); a reprodução real só o smoke
  confirma. Se não houver fonte, a reprodução exigiria URLs de provedor no banco
  de teste — decisão pendente, não tomada.

## 5. Roteiro exato do smoke da TV

Pré-requisito: §3 resolvido. Contas: as quatro contas fictícias (senhas
entregues fora do repositório).

### 5.1 Instalação e identificação

```bash
adb connect <ip-da-tv>:5555
```

```bash
adb install -r tv-homologacao.apk
```

```bash
adb shell dumpsys package com.obaflix.tv.homologacao | grep -E "versionName|versionCode"
```

Esperado: `0.7.25-homologacao`, `41`. O app oficial `com.obaflix.tv`
continua instalado e intocado.

### 5.2 Pareamento

1. Abrir **Obaflix TV (homologacao)**. Esperado: tela de pareamento com QR.
2. No celular, logado na Vercel, abrir o QR; entrar com
   `gratuito@teste.obaflix.invalid`; aprovar. Esperado: a TV entra na Home.
   📸 Home.

### 5.3 Login persistente

| Passo | Ação | Esperado | Evidência |
|---|---|---|---|
| 1 | Voltar até sair; abrir de novo | entra direto na Home | 📸 |
| 2 | Configurações → Apps → Obaflix TV (homologacao) → Forçar parada; abrir | entra direto | 📸 |
| 3 | Tirar a TV da tomada por 30 s; religar; abrir logo | "Conectando…" e depois Home, sem QR | 📸 das duas telas |
| 4 | Desligar o roteador; abrir o app | "Sem conexão. Tentando entrar na sua conta…" | 📸 |
| 5 | Religar o roteador | entra sozinho em até 30 s | 📸 |
| 6 | Deixar 20 min sem uso; abrir um conteúdo | carrega sem pedir login (access renovado) | 📸 |
| 7 | Perfil → Sair; fechar e abrir | pareamento, e continua no pareamento | 📸 |
| 8 | Parear de novo; no navegador, remover o aparelho; na TV abrir algo ou reabrir | volta ao pareamento | 📸 + `logcat` |

```bash
adb logcat -d | grep -E "restauracao_adiada|tv_refresh_recusado|tv_refresh_temporario|estado_nao_autenticado|sessao_volatil_apk_reassinado"
```

Esperado no passo 8: `tv_refresh_recusado`. Em nenhum passo:
`sessao_volatil_apk_reassinado`.

### 5.4 Planos e promoção (conta gratuita)

| Passo | Ação | Esperado |
|---|---|---|
| 9 | Abrir Planos | Básico (azul), Plus (roxo, "Mais escolhido"), Premium (âmbar), preços de 30 dias R$ 10,00 / 19,90 / 29,90 |
| 10 | Assinar um plano | QR leva a `/planos?plano=<id>` no Preview isolado |
| 11 | Abrir um filme | promoção antes da reprodução; concluir → reprodução |
| 12 | Episódio seguinte | nova promoção |
| 13 | Cancelar a promoção (Voltar) e reabrir o mesmo conteúdo | recuperação só no mesmo aparelho |

### 5.5 Assinante (pagamento simulado)

Compra pelo checkout do Preview isolado com `basico@`, `plus@` e `premium@`; a
venda simulada é marcada como paga pela rota de teste com `x-teste-token`.
Depois, parear a TV com cada conta:

| Passo | Esperado |
|---|---|
| 14 | reprodução **sem** promoção |
| 15 | Plus/Premium: canais conforme o nível (se houver canais cadastrados no banco de teste — hoje não há) |

Canais e VIP dependem de dados de canal e de fontes no banco de teste, que não
existem; ficam fora deste smoke até haver dados fictícios para eles.
