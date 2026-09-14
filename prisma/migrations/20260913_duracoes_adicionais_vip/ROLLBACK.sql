-- Desfaz 20260913_duracoes_adicionais_vip.
--
-- ATENCAO: so e seguro antes de existir pedido ou preco em meses. Com linhas em
-- meses, voltar `duracaoDias` para NOT NULL falha — de proposito: apagar a
-- duracao de uma compra paga nao e rollback, e perda de dado. Nesse caso o
-- rollback precisa de decisao de dados antes, e este arquivo para no erro.

BEGIN;

ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_credito_check";
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_composicao_check";
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_adicionais_check";
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_operacao_check";
ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_valores_check";
ALTER TABLE "PedidoPagamento" DROP COLUMN IF EXISTS "assinaturasSubstituidas";
ALTER TABLE "PedidoPagamento" DROP COLUMN IF EXISTS "operacao";
ALTER TABLE "PedidoPagamento" DROP COLUMN IF EXISTS "creditoCentavos";
ALTER TABLE "PedidoPagamento" DROP COLUMN IF EXISTS "valorAdicionaisCentavos";
ALTER TABLE "PedidoPagamento" DROP COLUMN IF EXISTS "valorPlanoCentavos";
ALTER TABLE "PedidoPagamento" DROP COLUMN IF EXISTS "servidorVip";
ALTER TABLE "PedidoPagamento" DROP COLUMN IF EXISTS "telasAdicionais";
ALTER TABLE "PedidoPagamento" ALTER COLUMN "duracaoDias" SET NOT NULL;
ALTER TABLE "PedidoPagamento" DROP COLUMN IF EXISTS "duracaoMeses";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_valores_check"
    CHECK ("valorCentavos" > 0 AND "duracaoDias" > 0);

ALTER TABLE "Assinatura" DROP CONSTRAINT IF EXISTS "Assinatura_telasAdicionais_check";
ALTER TABLE "Assinatura" DROP COLUMN IF EXISTS "servidorVip";
ALTER TABLE "Assinatura" DROP COLUMN IF EXISTS "telasAdicionais";

DROP TABLE IF EXISTS "PlanoAdicionalPreco";

ALTER TABLE "PlanoPreco" DROP CONSTRAINT IF EXISTS "PlanoPreco_duracao_check";
ALTER TABLE "PlanoPreco" DROP CONSTRAINT IF EXISTS "PlanoPreco_valores_check";
ALTER TABLE "PlanoPreco" ALTER COLUMN "duracaoDias" SET NOT NULL;
ALTER TABLE "PlanoPreco" DROP COLUMN IF EXISTS "duracaoMeses";
ALTER TABLE "PlanoPreco" ADD CONSTRAINT "PlanoPreco_valores_check"
    CHECK ("duracaoDias" > 0 AND "precoCentavos" >= 0
           AND ("precoOriginalCentavos" IS NULL OR "precoOriginalCentavos" >= 0));

ALTER TABLE "Plano" DROP COLUMN IF EXISTS "servidorVip";

COMMIT;
