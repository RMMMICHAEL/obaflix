-- Rollback de 20260911_canais.
--
-- Seguro enquanto nenhuma outra tabela referenciar `Canal`. As duas tabelas
-- nasceram nesta migration e nenhuma linha de outra tabela aponta para elas.
--
-- Destrutivo: leva embora a curadoria de nivel feita a mao. Antes de rodar em
-- producao, exporte:
--   \copy (SELECT slug, "nivelMinimo", "nivelRevisado", ativo FROM "Canal") TO 'canais-curadoria.csv' CSV HEADER

BEGIN;

DROP TABLE IF EXISTS "CanalFonte";
DROP TABLE IF EXISTS "Canal";

COMMIT;
