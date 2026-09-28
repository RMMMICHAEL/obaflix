-- Aditiva: itens lidos na origem em cada SyncRun (null = produtor não informa).
-- Depende de 20260928150000_admin_surface_observability. Reexecutar é inofensivo.

BEGIN;

ALTER TABLE "SyncRun" ADD COLUMN IF NOT EXISTS "found" INTEGER;

COMMIT;
