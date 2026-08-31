-- A vitrine de episódios escolhe um card por série, priorizando temporada,
-- episódio e data. Este índice evita uma varredura completa para cada série.
CREATE INDEX IF NOT EXISTS "Episodio_vitrine_recente_idx"
ON "Episodio" ("serieId", "temporada" DESC, "numeroEp" DESC, "createdAt" DESC);
