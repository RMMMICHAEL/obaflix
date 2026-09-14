-- Marcador do banco EXCLUSIVO de testes.
--
-- Executar SOMENTE no banco novo, vazio, criado para o ambiente de testes, e
-- somente com autorizacao especifica. Nunca em Production nem no banco que o
-- Preview atual usa.
--
-- Uso (psql, variavel obrigatoria):
--   psql "$DATABASE_URL_TESTE" -v ambiente_id=<uuid-gerado-na-hora> -f 01-marcador-do-banco-de-teste.sql
--
-- O id identifica este banco em toda autorizacao posterior (migration, precos,
-- dados ficticios). Ele nao e segredo: e um identificador.

\set ON_ERROR_STOP on

BEGIN;

-- Recusa banco que ja tenha dados de produto: marcador se coloca em banco vazio.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User') THEN
        IF (SELECT count(*) FROM "User") > 0 THEN
            RAISE EXCEPTION 'Banco com usuarios: nao parece o banco novo de testes. Abortado.';
        END IF;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "_ObaflixAmbiente" (
    "id" UUID PRIMARY KEY,
    "ambiente" TEXT NOT NULL CHECK ("ambiente" = 'teste'),
    "criadoEm" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma linha so.
CREATE UNIQUE INDEX IF NOT EXISTS "_ObaflixAmbiente_unico" ON "_ObaflixAmbiente" ((true));

INSERT INTO "_ObaflixAmbiente" ("id", "ambiente") VALUES (:'ambiente_id', 'teste');

ALTER TABLE "_ObaflixAmbiente" ENABLE ROW LEVEL SECURITY;

COMMIT;

SELECT "id", "ambiente", "criadoEm", current_database() AS banco FROM "_ObaflixAmbiente";
