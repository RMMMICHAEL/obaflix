-- Verificacao de 20260911_canais. Somente leitura: nao altera nada.
-- Esperado: todas as linhas com ok = true.

-- 1. As duas tabelas existem.
SELECT 'tabelas' AS checagem, count(*) = 2 AS ok, count(*) AS achado
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('Canal', 'CanalFonte');

-- 2. Os tres CHECK de politica estao no lugar.
SELECT 'checks' AS checagem, count(*) = 3 AS ok, count(*) AS achado
FROM pg_constraint
WHERE conrelid = '"Canal"'::regclass AND contype = 'c'
  AND conname IN ('Canal_nivelMinimo_dominio', 'Canal_ativo_exige_revisao',
                  'Canal_adulto_fora_do_catalogo');

-- 3. RLS ligado nas duas.
SELECT 'rls' AS checagem, bool_and(relrowsecurity) AS ok, count(*) AS achado
FROM pg_class WHERE relname IN ('Canal', 'CanalFonte');

-- 4. Nenhuma policy — sem policy e com RLS, PostgREST nao le.
SELECT 'sem_policy' AS checagem, count(*) = 0 AS ok, count(*) AS achado
FROM pg_policies WHERE tablename IN ('Canal', 'CanalFonte');

-- 5. Invariante de politica: nada ativo sem revisao, nada adulto no catalogo.
SELECT 'catalogo_seguro' AS checagem, count(*) = 0 AS ok, count(*) AS achado
FROM "Canal" WHERE (ativo AND NOT "nivelRevisado") OR (ativo AND adulto);

-- 6. Nenhuma fonte orfa, e todo canal ativo tem fonte.
SELECT 'fontes' AS checagem, count(*) = 0 AS ok, count(*) AS achado
FROM "Canal" c LEFT JOIN "CanalFonte" f ON f."canalId" = c.id
WHERE c.ativo AND f."canalId" IS NULL;
