-- Tabelas da revisao manual de pagamentos — SOMENTE no banco exclusivo de testes.
--
-- Mesmo SQL proposto em docs/revisao-manual-pagamentos.md §6. Em Production
-- continua sem migration e sem autorizacao.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_ObaflixAmbiente') THEN
        RAISE EXCEPTION 'Sem marcador _ObaflixAmbiente: NAO e o banco de testes. Abortado.';
    END IF;
END $$;

BEGIN;

CREATE TABLE "RevisaoPagamento" (
    "id" TEXT NOT NULL,
    "pedidoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resolucao" TEXT,
    "abertaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvidaEm" TIMESTAMP(3),
    "atualizadoEm" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RevisaoPagamento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevisaoPagamento_pedidoId_fkey" FOREIGN KEY ("pedidoId")
        REFERENCES "PedidoPagamento"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "RevisaoPagamento_status_check" CHECK ("status" IN ('PENDENTE', 'RESOLVIDA')),
    CONSTRAINT "RevisaoPagamento_resolucao_check" CHECK (
        ("status" = 'PENDENTE' AND "resolucao" IS NULL AND "resolvidaEm" IS NULL)
        OR ("status" = 'RESOLVIDA' AND "resolucao" IS NOT NULL AND "resolvidaEm" IS NOT NULL)),
    CONSTRAINT "RevisaoPagamento_motivo_check" CHECK ("motivo" IN (
        'criacao_valor_divergente', 'criacao_falha_com_transacao', 'confirmacao_divergente',
        'confirmacao_status_desconhecido', 'pago_apos_expiracao', 'pedido_em_estado_inesperado',
        'pedido_ja_vinculado', 'ativacao_periodo_em_aberto', 'ativacao_substituicao_divergente',
        'ativacao_duracao_invalida', 'ativacao_operacao_invalida', 'estorno_upgrade',
        'reconciliacao_inconsistente'))
);

CREATE UNIQUE INDEX "RevisaoPagamento_pendente_unico_idx"
    ON "RevisaoPagamento"("pedidoId") WHERE "status" = 'PENDENTE';
CREATE INDEX "RevisaoPagamento_status_abertaEm_idx" ON "RevisaoPagamento"("status", "abertaEm");
CREATE INDEX "RevisaoPagamento_userId_status_idx" ON "RevisaoPagamento"("userId", "status");
CREATE INDEX "RevisaoPagamento_pedidoId_idx" ON "RevisaoPagamento"("pedidoId");

CREATE TABLE "RevisaoPagamentoEvento" (
    "id" TEXT NOT NULL,
    "revisaoId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "ator" TEXT NOT NULL,
    "observacao" TEXT,
    "chaveIdempotencia" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RevisaoPagamentoEvento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevisaoPagamentoEvento_revisaoId_fkey" FOREIGN KEY ("revisaoId")
        REFERENCES "RevisaoPagamento"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "RevisaoPagamentoEvento_tipo_check" CHECK ("tipo" IN
        ('aberta', 'motivo_registrado', 'acao_executada', 'acao_recusada', 'resolvida')),
    CONSTRAINT "RevisaoPagamentoEvento_observacao_check" CHECK ("observacao" IS NULL OR length("observacao") <= 500)
);

CREATE UNIQUE INDEX "RevisaoPagamentoEvento_chaveIdempotencia_key"
    ON "RevisaoPagamentoEvento"("chaveIdempotencia");
CREATE INDEX "RevisaoPagamentoEvento_revisaoId_criadoEm_idx"
    ON "RevisaoPagamentoEvento"("revisaoId", "criadoEm");

CREATE OR REPLACE FUNCTION "revisao_evento_imutavel"() RETURNS trigger AS $fn$
BEGIN
    RAISE EXCEPTION 'RevisaoPagamentoEvento e somente insercao';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER "RevisaoPagamentoEvento_imutavel"
    BEFORE UPDATE OR DELETE ON "RevisaoPagamentoEvento"
    FOR EACH ROW EXECUTE FUNCTION "revisao_evento_imutavel"();

ALTER TABLE "RevisaoPagamento" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevisaoPagamentoEvento" ENABLE ROW LEVEL SECURITY;

COMMIT;
