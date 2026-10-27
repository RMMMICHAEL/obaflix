# Obaflix Cortes — abertura das vendas

Branch `feat/cortes-comercial`. Funil: `/cortes` → `/checkout` (sem login) → Pix
BlackCat → webhook/confirmação → conta criada ou vinculada → e-mail de ativação
(`/ativar`) → app Windows.

## Validado em ambiente de teste (Neon/Redis de teste, provedor simulado)

Jornada pelo navegador contra servidor local isolado: página de vendas sem login
→ Cortes Start → checkout do plano → dados fictícios (com nascimento) → PIX
simulado não pagável → confirmação simulada → conta + assinatura + 1 e-mail
simulado → senha pelo link → login → Start libera trecho e bloqueia lote →
avisos repetidos sem duplicar → compra logada do Básico (as duas ativas) →
upgrade Start → Pro (Básico intacto, Start substituído, lote liberado).
CPF não gravado; nascimento no pedido e na conta nova.

## Decisões do responsável (nada disto está feito)

1. **Preços oficiais** de Start e Pro e a duração:
   `npx tsx scripts/cortes-precos-oficiais.ts --start=<centavos> --pro=<centavos>`
   (simula; acrescente `--aplicar` para gravar). Cortes AI fica inativo.
2. **Instalador Windows com Cortes**: o publicado (1.0.12) não tem Cortes. Depois
   de gerar e homologar o instalador, configurar `NEXT_PUBLIC_DOWNLOAD_WINDOWS_CORTES`
   (+ `_VERSAO`, `_TAMANHO`). Sem isso, `/cortes` mostra "em preparação".
3. **Idade mínima de compra**: 18 anos (`IDADE_MINIMA_COMPRA`, `billing/pagador.ts`).

## Operações que exigem autorização específica

- **E-mail real (Resend)**: domínio `obaflixbr.com` verificado (SPF/DKIM), então
  `EMAIL_MODO=resend` + `RESEND_API_KEY` + `EMAIL_FROM` + `NEXTAUTH_URL` correto,
  e um envio para um endereço controlado.
- **PIX real de valor controlado** pela BlackCat, com reembolso previsto.
- **Production**: aplicar, nesta ordem e já validadas no Neon de teste,
  `20261020120000_pedido_compra_sem_login` e `20261021120000_nascimento_comprador`
  (pelo procedimento de `docs/ambiente-teste.md`, nunca `migrate deploy` às cegas);
  depois merge, variáveis de Production (`BLACKCAT_*`, `EMAIL_*`,
  `CORTES_CONTROLE_ATIVO=true`) e preços.

## Observações

- Upgrade Start → Pro cobra a diferença com crédito do período restante; com
  preços muito próximos o valor pode ficar abaixo do mínimo aceito pelo provedor.
- Antes do merge, retirar a `feat/cortes-comercial` de `preview-ignorar-build.mjs`
  e do `ads-site/vercel.json` (proteção válida só para as branches de teste).
