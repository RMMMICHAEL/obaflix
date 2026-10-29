-- Meta CAPI: captura do rastreio do Pixel no pedido e controle de envio do Purchase.
-- Aditiva: 5 colunas anuláveis, sem default e sem reescrita de linhas (pedidos existentes ficam sem rastreio capturado = nada é enviado).
-- Reversão: ALTER TABLE "PedidoPagamento" DROP COLUMN das cinco colunas.
ALTER TABLE "PedidoPagamento"
  ADD COLUMN IF NOT EXISTS "metaRastreioCapturadoEm" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "metaFbp" TEXT,
  ADD COLUMN IF NOT EXISTS "metaFbc" TEXT,
  ADD COLUMN IF NOT EXISTS "metaUserAgent" TEXT,
  ADD COLUMN IF NOT EXISTS "metaPurchaseEnviadoEm" TIMESTAMP(3);
