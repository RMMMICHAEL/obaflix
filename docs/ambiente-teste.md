# Ambiente isolado de testes — preparação

Estado em 2026-09-14. **Nada provisionado, nada aplicado.** Este documento
reúne os arquivos, a configuração e os comandos. Cada passo marcado 🔐 exige
autorização específica, com o destino informado antes.

O Preview atual **não** serve: `DATABASE_URL`/`DIRECT_URL` do Preview são os de
Production. Nenhum teste que grave dados roda nele.

## 1. Recursos

| Recurso | Destino proposto | Custo | Arquivo / comando |
|---|---|---|---|
| Banco | projeto Postgres **novo** (ex.: Supabase `obaflix-teste`), vazio | plano gratuito cobre o smoke; confirmar limites antes | §3 |
| Redis | banco Upstash **novo** (`obaflix-teste`) | plano gratuito cobre o smoke | §2 |
| Deploy web | Vercel, **Preview restrito à branch** de teste, com variáveis próprias | sem custo adicional no plano atual; confirmar | §2 |
| Worker de canais | `obaflix-media-teste` (`wrangler.toml`, `[env.teste]`) | só se o smoke incluir canais | §5 |
| Pagamento | simulação controlada (§4) — sandbox da Blackcat não encontrado na documentação pública | — | §4 |
| APK de TV | `assembleHomologacao` (PR #29) com a URL do deploy de teste | — | `docs/tv-login-persistente.md` §6 |

## 2. Variáveis

Modelo: `scripts/ambiente-teste/variaveis-ambiente-teste.example` (fora do
padrão `.env*`, que o `.gitignore` ignora). Regras:

- **todos** os segredos são novos: `NEXTAUTH_SECRET`, `ADMIN_SECRET_TOKEN`,
  `CRON_SECRET`, `BLACKCAT_WEBHOOK_PATH_SECRET`, `TESTE_PAGAMENTO_TOKEN`,
  `CANAIS_MEDIA_SIGNING_SECRET`;
- `DATABASE_URL`, `DIRECT_URL`, `UPSTASH_*`, `REDIS_URL` apontam para os recursos
  novos;
- `MONETIZACAO_ATIVA=true` **somente** neste escopo;
- nenhuma variável de Production é alterada.

🔐 Comandos (um por variável; o valor é digitado no prompt, nunca na linha de comando):

```bash
vercel env add DATABASE_URL preview feat/tv-planos-promocao
```

```bash
vercel env add NEXTAUTH_SECRET preview feat/tv-planos-promocao
```

(repetir para cada variável de `variaveis-ambiente-teste.example`)

Conferência sem expor valores:

```bash
vercel env ls preview feat/tv-planos-promocao
```

## 3. Banco: identificação antes de qualquer escrita

1. 🔐 Criar o projeto Postgres novo.
2. 🔐 Gravar o marcador (só no banco novo; o script recusa banco com usuários):

   ```bash
   psql "$DATABASE_URL_TESTE" -v ambiente_id=<uuid-novo> -f scripts/ambiente-teste/01-marcador-do-banco-de-teste.sql
   ```

3. Pré-verificação — **antes de cada** migration, preço ou dado fictício, com a
   mesma URL:

   ```bash
   psql "$DATABASE_URL_TESTE" -v ambiente_id=<uuid-autorizado> -f scripts/ambiente-teste/02-verificar-destino.sql
   ```

   Aborta sem marcador, com id diferente, com pedido `PAGO` de provedor real ou
   com usuário fora de `@teste.obaflix.invalid`. Imprime `ambiente_id`, banco e
   porta para conferência humana.

4. 🔐 Schema base, migration `20260913` e SQL de revisão manual
   (`docs/revisao-manual-pagamentos.md` §6), cada um precedido do passo 3.
5. 🔐 Preços: `npm run precos:planos -- --apply --banco=<host>` precedido do
   passo 3.
6. 🔐 Contas fictícias: uma por plano, e-mail `@teste.obaflix.invalid`, CPF de
   teste só para validação de formato.

**Autorização pedida para cada passo 🔐:**
- ambiente;
- identificador do projeto no provedor (sem segredo);
- `ambiente_id` do marcador;
- saída do passo 3;
- comando exato.

## 4. Pagamento

A documentação pública da Blackcat não mostra ambiente sandbox. Até o provedor
confirmar um, o ambiente usa **simulação controlada**:

- ligada só com `PAGAMENTO_SIMULADO=true` **e** `OBAFLIX_AMBIENTE=teste` **e**
  `VERCEL_ENV` diferente de `production`; qualquer uma ausente, o código usa a
  Blackcat normal (e, sem chave, recusa cobrar);
- o pedido fica com `provedor = "simulado"`; o estado da venda vive no Redis de
  teste;
- o operador de teste muda o estado da venda por
  `POST /api/teste/pagamento-simulado` com `x-teste-token`
  (`TESTE_PAGAMENTO_TOKEN`); fora do ambiente de teste a rota responde 404;
- confirmação, revisão, estorno e reconciliação passam pelo mesmo código de
  produção — só a origem do status muda;
- 🔐 o banco de teste precisa aceitar `provedor = 'simulado'`:
  `scripts/ambiente-teste/03-provedor-simulado-somente-teste.sql` confere o
  marcador antes de ampliar o CHECK. Production mantém `CHECK (provedor IN
  ('blackcat'))`, então um pedido simulado não grava lá nem com configuração
  errada.

**Isto não valida a integração real** (criação de venda, webhook e consulta na
Blackcat). Nenhum PIX real está autorizado.

## 5. Worker de canais (se o smoke incluir canais)

```bash
npx wrangler secret put ASSINATURA_SECRET --env teste
```

```bash
npx wrangler secret put UPSTASH_REDIS_REST_URL --env teste
```

```bash
npx wrangler secret put UPSTASH_REDIS_REST_TOKEN --env teste
```

🔐 Deploy:

```bash
npx wrangler deploy --env teste
```

Antes, preencher em `[env.teste.vars]`: `APP_ORIGIN` (origem do deploy de
teste), `CDN_ALLOWLIST`, `CANAIS_PLAYER_ALLOWLIST`, `CANAIS_MEDIA_BASE`.

## 6. Smoke

Roteiros: `docs/validacao-isolada.md` §6 (planos, checkout, promoção, VIP,
canais), `docs/revisao-manual-pagamentos.md` §5 (revisão) e
`docs/tv-login-persistente.md` §8 (login da TV). Screenshots só de execução real.
