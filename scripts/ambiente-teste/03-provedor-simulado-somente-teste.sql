-- Aceita o provedor 'simulado' SOMENTE no banco exclusivo de testes.
--
-- Production continua com CHECK ("provedor" IN ('blackcat')): mesmo com flags
-- erradas, um pedido simulado nao grava la. NUNCA executar fora do banco marcado.
--
-- SQL puro (roda com `prisma db execute`). O id do marcador e conferido antes,
-- por `ambiente-teste.ts verificar --ambiente-id=<uuid>`; aqui o bloco abaixo
-- ainda recusa qualquer banco sem o marcador de teste.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_ObaflixAmbiente') THEN
        RAISE EXCEPTION 'Sem marcador _ObaflixAmbiente: NAO e o banco de testes. Abortado.';
    END IF;
    IF (SELECT count(*) FROM "_ObaflixAmbiente" WHERE "ambiente" = 'teste') <> 1 THEN
        RAISE EXCEPTION 'Marcador de teste invalido. Abortado.';
    END IF;
END $$;

BEGIN;

ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_provedor_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_provedor_check"
    CHECK ("provedor" IN ('blackcat', 'simulado'));

ALTER TABLE "EventoPagamento" DROP CONSTRAINT IF EXISTS "EventoPagamento_provedor_check";
ALTER TABLE "EventoPagamento" ADD CONSTRAINT "EventoPagamento_provedor_check"
    CHECK ("provedor" IN ('blackcat', 'simulado'));

COMMIT;
