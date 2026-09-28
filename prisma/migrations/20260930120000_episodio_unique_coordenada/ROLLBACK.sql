-- Rollback de 20260930120000_episodio_unique_coordenada.
--
-- Só remove o índice; nenhum dado muda. Depois dele, produtores voltam a poder
-- gravar duplicatas se houver corrida (o código já procura pela coordenada).
-- O dedupe NÃO é revertido por aqui: para isso existe o backup JSON gerado por
-- scripts/dedupe-episodios.ts --apply.

BEGIN;

DROP INDEX IF EXISTS "Episodio_serieId_temporada_numeroEp_key";

COMMIT;
