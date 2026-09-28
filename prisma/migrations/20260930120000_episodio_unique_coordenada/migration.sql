-- Índice único da coordenada do episódio: (serieId, temporada, numeroEp).
--
-- O schema declara `@@unique([serieId, temporada, numeroEp])` desde o início,
-- mas o índice nunca foi criado no banco (ver scripts/verificar-tv-tabelas.ts).
-- Sem ele, `createMany({ skipDuplicates })` só pulava conflito de ID e o mesmo
-- episódio com IDs diferentes virava duas linhas.
--
-- NÃO remove duplicatas. Se ainda houver alguma, a migration FALHA antes de
-- criar o índice e nada muda. Ordem obrigatória (docs/admin-cutover-final.md):
--   1. backup;  2. scripts/dedupe-episodios.ts (dry-run);  3. --apply;
--   4. VERIFICACAO.sql bloco A (zero duplicatas);  5. esta migration;
--   6. VERIFICACAO.sql bloco B;  7. smoke de upsert.
--
-- O nome é o que o Prisma gera para o @@unique, para o schema e o banco
-- concordarem. Reexecutar é inofensivo (IF NOT EXISTS).
--
-- Bloqueio: CREATE UNIQUE INDEX (sem CONCURRENTLY, que não roda em transação)
-- segura escritas em "Episodio" enquanto constrói — segundos para ~360 mil
-- linhas. Leituras continuam. lock_timeout evita ficar parado atrás de um sync.

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  grupos bigint;
BEGIN
  SELECT count(*) INTO grupos FROM (
    SELECT 1 FROM "Episodio"
    GROUP BY "serieId", "temporada", "numeroEp"
    HAVING count(*) > 1
  ) d;
  IF grupos > 0 THEN
    RAISE EXCEPTION 'Episodio ainda tem % coordenada(s) duplicada(s). Rode scripts/dedupe-episodios.ts --apply antes desta migration.', grupos;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Episodio_serieId_temporada_numeroEp_key"
ON "Episodio" ("serieId", "temporada", "numeroEp");

COMMIT;
