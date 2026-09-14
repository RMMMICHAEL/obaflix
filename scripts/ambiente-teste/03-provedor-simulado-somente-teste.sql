-- Aceita o provedor 'simulado' SOMENTE no banco exclusivo de testes.
--
-- Production continua com CHECK ("provedor" IN ('blackcat')): mesmo com flags
-- erradas, um pedido simulado nao grava la. NUNCA executar fora do banco marcado.
--
--   psql "$DATABASE_URL_TESTE" -v ambiente_id=<uuid-autorizado> -f 03-provedor-simulado-somente-teste.sql
--
-- Pre-requisitos: 01 (marcador) e schema aplicado; rodar 02 antes, na mesma URL.

\set ON_ERROR_STOP on

SELECT CASE WHEN count(*) = 1 THEN 'ok' END AS marcador_confere
FROM information_schema.tables t
JOIN "_ObaflixAmbiente" m ON m."id" = :'ambiente_id' AND m."ambiente" = 'teste'
WHERE t.table_schema = 'public' AND t.table_name = '_ObaflixAmbiente'
\gset
\if :{?marcador_confere}
\else
    \echo 'Sem marcador do banco de testes com o id autorizado. Abortado.'
    \quit 3
\endif

BEGIN;

ALTER TABLE "PedidoPagamento" DROP CONSTRAINT IF EXISTS "PedidoPagamento_provedor_check";
ALTER TABLE "PedidoPagamento" ADD CONSTRAINT "PedidoPagamento_provedor_check"
    CHECK ("provedor" IN ('blackcat', 'simulado'));

ALTER TABLE "EventoPagamento" DROP CONSTRAINT IF EXISTS "EventoPagamento_provedor_check";
ALTER TABLE "EventoPagamento" ADD CONSTRAINT "EventoPagamento_provedor_check"
    CHECK ("provedor" IN ('blackcat', 'simulado'));

COMMIT;
