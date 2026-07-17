-- AddColumn popularRankPrev to Filme and Serie
-- Safe: nullable columns, zero data loss

ALTER TABLE "Filme" ADD COLUMN IF NOT EXISTS "popularRankPrev" INTEGER;
ALTER TABLE "Serie" ADD COLUMN IF NOT EXISTS "popularRankPrev" INTEGER;
