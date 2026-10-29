-- Meta CAPI: consentimento de publicidade registrado no pedido e controle de envio do Purchase.
-- Aditiva: 4 colunas anuláveis, sem default e sem reescrita de linhas (pedidos existentes ficam sem consentimento = nada é enviado).
-- Reversão: ALTER TABLE "PedidoPagamento" DROP COLUMN das quatro colunas.
ALTER TABLE "PedidoPagamento"
  ADD COLUMN IF NOT EXISTS "consentimentoAnunciosEm" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "metaFbp" TEXT,
  ADD COLUMN IF NOT EXISTS "metaFbc" TEXT,
  ADD COLUMN IF NOT EXISTS "metaPurchaseEnviadoEm" TIMESTAMP(3);
