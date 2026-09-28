-- Confere 20260930120000_episodio_unique_coordenada. Somente leitura.
-- Toda coluna `ok` precisa vir `true`.

-- ── Bloco A: ANTES da migration (depois do dedupe --apply) ───────────────────

-- A1. Nenhuma coordenada duplicada.
SELECT 'A1 zero duplicatas' AS item,
       count(*) = 0 AS ok,
       count(*) AS grupos_duplicados
FROM (
  SELECT 1 FROM "Episodio"
  GROUP BY "serieId", "temporada", "numeroEp"
  HAVING count(*) > 1
) d;

-- A2. Nenhum WatchHistory órfão (episodioId sem episódio).
SELECT 'A2 sem WatchHistory orfao' AS item,
       count(*) = 0 AS ok
FROM "WatchHistory" w
LEFT JOIN "Episodio" e ON e.id = w."episodioId"
WHERE w."episodioId" IS NOT NULL AND e.id IS NULL;

-- ── Bloco B: DEPOIS da migration ─────────────────────────────────────────────

-- B1. O índice existe, é único, válido e cobre exatamente as três colunas.
SELECT 'B1 indice unico valido' AS item,
       count(*) = 1 AS ok
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'Episodio'
  AND c.relname = 'Episodio_serieId_temporada_numeroEp_key'
  AND i.indisunique AND i.indisvalid
  AND pg_get_indexdef(i.indexrelid) LIKE '%("serieId", temporada, "numeroEp")%';

-- B2. Nenhum outro índice foi tocado: os anteriores continuam lá.
SELECT 'B2 indices anteriores intactos' AS item,
       count(*) = 2 AS ok
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'Episodio'
  AND indexname IN ('Episodio_pkey', 'Episodio_vitrine_recente_idx');

-- B3. Smoke de upsert (roda e desfaz; não deixa linha). Descomente para usar
-- numa série de teste existente (troque <serieId>):
-- BEGIN;
--   INSERT INTO "Episodio" (id, "serieId", temporada, "numeroEp")
--   VALUES ('smoke-a', '<serieId>', 999, 1);
--   INSERT INTO "Episodio" (id, "serieId", temporada, "numeroEp")
--   VALUES ('smoke-b', '<serieId>', 999, 1)
--   ON CONFLICT ("serieId", temporada, "numeroEp") DO NOTHING;
--   SELECT 'B3 segunda linha recusada' AS item, count(*) = 1 AS ok
--   FROM "Episodio" WHERE "serieId" = '<serieId>' AND temporada = 999;
-- ROLLBACK;
