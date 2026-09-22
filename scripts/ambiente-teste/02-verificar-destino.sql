-- Pre-verificacao do destino. Rodar ANTES de qualquer migration, preco ou dado
-- ficticio, na mesma sessao/URL que sera usada depois.
--
--   psql "$DATABASE_URL_TESTE" -v ambiente_id=<uuid-informado-na-autorizacao> -f 02-verificar-destino.sql
--
-- Aborta (ON_ERROR_STOP) se:
--   1. o marcador nao existir (Production nao tem);
--   2. o id nao for o informado na autorizacao;
--   3. houver pedido PAGO (dinheiro real);
--   4. houver usuario fora do dominio ficticio.
-- Termina imprimindo a identificacao para conferencia humana, sem segredo.

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_ObaflixAmbiente') THEN
        RAISE EXCEPTION 'Sem marcador _ObaflixAmbiente: este NAO e o banco de testes. Abortado.';
    END IF;
END $$;

SELECT CASE WHEN count(*) = 1 THEN 'ok' END AS marcador_confere
FROM "_ObaflixAmbiente"
WHERE "id" = :'ambiente_id' AND "ambiente" = 'teste'
\gset
\if :{?marcador_confere}
\else
    \echo 'Id do marcador diferente do autorizado. Abortado.'
    \quit 3
\endif

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'PedidoPagamento') THEN
        IF EXISTS (SELECT 1 FROM "PedidoPagamento" WHERE "status" = 'PAGO' AND "provedor" <> 'simulado') THEN
            RAISE EXCEPTION 'Ha pedido PAGO de provedor real: nao e banco de testes. Abortado.';
        END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User') THEN
        IF EXISTS (SELECT 1 FROM "User" WHERE "email" NOT LIKE '%@teste.obaflix.invalid') THEN
            RAISE EXCEPTION 'Ha usuario fora do dominio ficticio: nao e banco de testes. Abortado.';
        END IF;
    END IF;
END $$;

SELECT
    m."id"                AS ambiente_id,
    m."ambiente"          AS ambiente,
    current_database()    AS banco,
    inet_server_port()    AS porta,
    (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS tabelas
FROM "_ObaflixAmbiente" m;
