-- Segundo gateway: aceita 'cakto' em PedidoPagamento e EventoPagamento.
-- Aditiva e sem alterar linhas: só amplia o CHECK. O banco de teste (marcador
-- _ObaflixAmbiente) é pulado: lá o CHECK vem de
-- scripts/ambiente-teste/03-provedor-simulado-somente-teste.sql, com 'simulado'.
-- Reversão (só sem pedidos Cakto): os mesmos ALTER com IN ('blackcat').
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_ObaflixAmbiente') THEN
        RETURN;
    END IF;
    ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_provedor_check";
    ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_provedor_check"
        CHECK ("provedor" IN ('blackcat', 'cakto'));
    ALTER TABLE "EventoPagamento" DROP CONSTRAINT IF EXISTS "EventoPagamento_provedor_check";
    ALTER TABLE "EventoPagamento" ADD CONSTRAINT "EventoPagamento_provedor_check"
        CHECK ("provedor" IN ('blackcat', 'cakto'));
END $$;
