-- Fase 5: trilha mínima e idempotente de avisos Blackcat.
BEGIN;
CREATE TABLE "EventoPagamento" (
 "id" TEXT NOT NULL, "provedor" TEXT NOT NULL, "transacaoId" TEXT NOT NULL,
 "evento" TEXT NOT NULL, "statusInformado" TEXT NOT NULL, "pedidoId" TEXT,
 "resultado" TEXT NOT NULL, "recebidoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "processadoEm" TIMESTAMP(3), CONSTRAINT "EventoPagamento_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "EventoPagamento" ADD CONSTRAINT "EventoPagamento_provedor_check" CHECK ("provedor" IN ('blackcat'));
ALTER TABLE "EventoPagamento" ADD CONSTRAINT "EventoPagamento_nao_vazio_check" CHECK (length("transacaoId") > 0 AND length("evento") > 0 AND length("statusInformado") > 0 AND length("resultado") > 0);
CREATE UNIQUE INDEX "EventoPagamento_provedor_transacaoId_evento_statusInformado_key" ON "EventoPagamento"("provedor", "transacaoId", "evento", "statusInformado");
CREATE INDEX "EventoPagamento_pedidoId_recebidoEm_idx" ON "EventoPagamento"("pedidoId", "recebidoEm");
CREATE INDEX "EventoPagamento_resultado_recebidoEm_idx" ON "EventoPagamento"("resultado", "recebidoEm");
ALTER TABLE "EventoPagamento" ADD CONSTRAINT "EventoPagamento_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "PedidoPagamento"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EventoPagamento" ENABLE ROW LEVEL SECURITY;
COMMIT;
