-- Additive only: items read from the source in each SyncRun (null = not reported).
ALTER TABLE "SyncRun" ADD COLUMN "found" INTEGER;
