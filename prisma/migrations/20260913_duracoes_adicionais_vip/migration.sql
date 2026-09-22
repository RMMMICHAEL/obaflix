-- Durações em meses, adicionais (telas e servidor VIP), operação e crédito no
-- pedido, e o direito servidorVip.
--
-- ESTA MIGRATION NAO FOI APLICADA EM NENHUM BANCO. Preview e Production
-- compartilham DATABASE_URL; aplicar exige autorizacao explicita e banco alvo
-- confirmado.
--
-- Regras aprovadas em 2026-09-13:
--   - 5 meses e 1 ano sao meses de calendario; dia inexistente vira o ultimo
--     dia do mes final (calculo em src/lib/billing/vigencia.ts);
--   - servidor VIP do Basico: preco mensal, acompanha a assinatura inteira;
--   - no maximo 2 telas adicionais, preco mensal, acompanham a assinatura;
--   - renovacao soma ao vencimento; upgrade imediato com credito proporcional
--     calculado no servidor; downgrade so no fim do periodo pago.
--
-- Aditiva no efeito: nenhum dado existente muda de significado. Colunas novas
-- nascem com default que reproduz o comportamento de hoje (0 telas extras, sem
-- VIP, operacao 'nova', credito 0). As duas colunas `duracaoDias` deixam de ser
-- NOT NULL, mas todas as linhas existentes continuam com valor e passam no novo
-- CHECK de "exatamente uma duracao".
--
-- Mesmo estilo das migrations anteriores: SQL executado direto, transacao
-- explicita, CHECK/indice parcial/RLS escritos a mao por cima do que o Prisma
-- expressa.

BEGIN;

-- ── Plano: servidor VIP incluso ──────────────────────────────────────────────

ALTER TABLE "Plano" ADD COLUMN IF NOT EXISTS "servidorVip" BOOLEAN NOT NULL DEFAULT false;

-- ── PlanoPreco: duracao em dias OU meses ─────────────────────────────────────

ALTER TABLE "PlanoPreco" ADD COLUMN IF NOT EXISTS "duracaoMeses" INTEGER;
ALTER TABLE "PlanoPreco" ALTER COLUMN "duracaoDias" DROP NOT NULL;

ALTER TABLE "PlanoPreco" DROP CONSTRAINT IF EXISTS "PlanoPreco_valores_check";
ALTER TABLE "PlanoPreco" ADD CONSTRAINT "PlanoPreco_valores_check"
    CHECK ("precoCentavos" >= 0
           AND ("precoOriginalCentavos" IS NULL OR "precoOriginalCentavos" >= 0));

ALTER TABLE "PlanoPreco" DROP CONSTRAINT IF EXISTS "PlanoPreco_duracao_check";
ALTER TABLE "PlanoPreco" ADD CONSTRAINT "PlanoPreco_duracao_check"
    CHECK (("duracaoDias" IS NOT NULL AND "duracaoDias" > 0 AND "duracaoMeses" IS NULL)
        OR ("duracaoMeses" IS NOT NULL AND "duracaoMeses" BETWEEN 1 AND 24 AND "duracaoDias" IS NULL));

-- ── PlanoAdicionalPreco ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "PlanoAdicionalPreco" (
    "id" TEXT NOT NULL,
    "planoId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    -- Mensal, em centavos inteiros. O total e mensal x meses cobraveis.
    "precoMensalCentavos" INTEGER NOT NULL,
    "moeda" TEXT NOT NULL DEFAULT 'BRL',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanoAdicionalPreco_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PlanoAdicionalPreco" DROP CONSTRAINT IF EXISTS "PlanoAdicionalPreco_tipo_check";
ALTER TABLE "PlanoAdicionalPreco" ADD CONSTRAINT "PlanoAdicionalPreco_tipo_check"
    CHECK ("tipo" IN ('tela', 'servidor_vip'));

ALTER TABLE "PlanoAdicionalPreco" DROP CONSTRAINT IF EXISTS "PlanoAdicionalPreco_valor_check";
ALTER TABLE "PlanoAdicionalPreco" ADD CONSTRAINT "PlanoAdicionalPreco_valor_check"
    CHECK ("precoMensalCentavos" > 0);

CREATE INDEX IF NOT EXISTS "PlanoAdicionalPreco_planoId_ativo_idx"
    ON "PlanoAdicionalPreco"("planoId", "ativo");

-- No maximo um preco ativo por (plano, tipo). Indice PARCIAL: o Prisma 5 nao o
-- representa, e um `migrate diff` futuro vai propor derruba-lo. Nao derrube.
CREATE UNIQUE INDEX IF NOT EXISTS "PlanoAdicionalPreco_ativo_unico_idx"
    ON "PlanoAdicionalPreco"("planoId", "tipo") WHERE "ativo";

ALTER TABLE "PlanoAdicionalPreco" DROP CONSTRAINT IF EXISTS "PlanoAdicionalPreco_planoId_fkey";
ALTER TABLE "PlanoAdicionalPreco" ADD CONSTRAINT "PlanoAdicionalPreco_planoId_fkey"
    FOREIGN KEY ("planoId") REFERENCES "Plano"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlanoAdicionalPreco" ENABLE ROW LEVEL SECURITY;

-- ── Assinatura: adicionais que acompanham o periodo ──────────────────────────

ALTER TABLE "Assinatura" ADD COLUMN IF NOT EXISTS "telasAdicionais" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Assinatura" ADD COLUMN IF NOT EXISTS "servidorVip" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_telasAdicionais_check";
ALTER TABLE "Assinatura" ADD CONSTRAINT "Assinatura_telasAdicionais_check"
    CHECK ("telasAdicionais" BETWEEN 0 AND 2);

-- ── PedidoPagamento: duracao, adicionais, operacao e credito em snapshot ─────

ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "duracaoMeses" INTEGER;
ALTER TABLE "PedidoPagamento" ALTER COLUMN "duracaoDias" DROP NOT NULL;
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "telasAdicionais" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "servidorVip" BOOLEAN NOT NULL DEFAULT false;
-- NULL nas linhas anteriores a esta migration: nao se sabe a decomposicao delas.
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "valorPlanoCentavos" INTEGER;
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "valorAdicionaisCentavos" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "creditoCentavos" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "operacao" TEXT NOT NULL DEFAULT 'nova';
ALTER TABLE "PedidoPagamento" ADD COLUMN IF NOT EXISTS "assinaturasSubstituidas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_valores_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_valores_check"
    CHECK ("valorCentavos" > 0
           AND (("duracaoDias" IS NOT NULL AND "duracaoDias" > 0 AND "duracaoMeses" IS NULL)
             OR ("duracaoMeses" IS NOT NULL AND "duracaoMeses" BETWEEN 1 AND 24 AND "duracaoDias" IS NULL)));

ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_operacao_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_operacao_check"
    CHECK ("operacao" IN ('nova', 'renovacao', 'upgrade', 'downgrade'));

ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_adicionais_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_adicionais_check"
    CHECK ("telasAdicionais" BETWEEN 0 AND 2
           AND "valorAdicionaisCentavos" >= 0
           AND "creditoCentavos" >= 0);

-- A composicao do valor cobrado, quando conhecida: plano + adicionais - credito.
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_composicao_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_composicao_check"
    CHECK ("valorPlanoCentavos" IS NULL
           OR ("valorPlanoCentavos" > 0
               AND "valorCentavos" = "valorPlanoCentavos" + "valorAdicionaisCentavos" - "creditoCentavos"));

-- Credito so existe em upgrade.
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_credito_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_credito_check"
    CHECK ("creditoCentavos" = 0 OR "operacao" = 'upgrade');

COMMIT;
