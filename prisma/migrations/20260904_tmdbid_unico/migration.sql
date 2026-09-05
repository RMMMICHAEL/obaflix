-- Unicidade canonica de tmdbId em Filme e Serie.
--
-- Esta migration e a trava que torna a duplicacao irrepetivel. Ate aqui nada no
-- banco impedia tres linhas para o mesmo titulo: cada pipeline de importacao
-- usava um espaco de id proprio (id do provedor, `wc_<id>`, e o proprio tmdbId
-- como chave primaria), e `tmdbId` era apenas uma coluna String opcional.
--
-- ORDEM OBRIGATORIA. Rode ANTES:
--   1. o cron ja corrigido (senao ele recria duplicata na madrugada seguinte);
--   2. npm run merge-duplicatas            -- dry-run, so relatorio
--   3. npm run merge-duplicatas:apply      -- migra vinculos e remove perdedores
--
-- Esta migration NAO apaga nada. Se ainda houver duplicata ela ABORTA com uma
-- mensagem que diz quantos grupos faltam — a transacao inteira volta atras e o
-- banco fica exatamente como estava. Preferir falhar a "resolver" apagando e o
-- ponto: foi apagando que o script antigo levou junto episodio e progresso de
-- usuario.

-- ── 1. Normaliza o vazio ─────────────────────────────────────────────────────
-- '' nao e NULL para um indice unico: duas linhas com tmdbId vazio colidiriam
-- entre si sem representarem o mesmo titulo. Limpar um valor que ja nao
-- identifica nada nao perde informacao.
UPDATE "Filme" SET "tmdbId" = NULL WHERE "tmdbId" IS NOT NULL AND btrim("tmdbId") = '';
UPDATE "Serie" SET "tmdbId" = NULL WHERE "tmdbId" IS NOT NULL AND btrim("tmdbId") = '';

-- ── 2. Recusa-se a continuar se o merge ainda nao rodou ──────────────────────
DO $$
DECLARE
  filmes_dup INT;
  series_dup INT;
BEGIN
  SELECT COUNT(*) INTO filmes_dup FROM (
    SELECT "tmdbId" FROM "Filme"
     WHERE "tmdbId" IS NOT NULL GROUP BY "tmdbId" HAVING COUNT(*) > 1
  ) d;

  SELECT COUNT(*) INTO series_dup FROM (
    SELECT "tmdbId" FROM "Serie"
     WHERE "tmdbId" IS NOT NULL GROUP BY "tmdbId" HAVING COUNT(*) > 1
  ) d;

  IF filmes_dup > 0 OR series_dup > 0 THEN
    RAISE EXCEPTION
      'Ainda ha duplicatas: % grupo(s) em Filme e % grupo(s) em Serie. Rode `npm run merge-duplicatas` (dry-run) e depois `npm run merge-duplicatas:apply` antes desta migration. Nada foi alterado.',
      filmes_dup, series_dup;
  END IF;
END $$;

-- ── 3. A trava ───────────────────────────────────────────────────────────────
-- Unique do Postgres aceita varios NULL, entao titulo sem tmdbId continua
-- podendo existir mais de uma vez — e correto: sem tmdbId nao ha prova de
-- identidade, e agrupar por titulo foi exatamente o erro anterior.
CREATE UNIQUE INDEX IF NOT EXISTS "Filme_tmdbId_key" ON "Filme" ("tmdbId");
CREATE UNIQUE INDEX IF NOT EXISTS "Serie_tmdbId_key" ON "Serie" ("tmdbId");
