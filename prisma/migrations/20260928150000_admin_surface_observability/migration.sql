-- Painel administrativo separado: telemetria de sincronização e auditoria.
--
-- IMPORTANTE:
-- - somente estrutura, aditiva: cria duas tabelas novas e seus índices;
-- - não altera, não apaga e não reescreve nenhuma tabela existente;
-- - a única ligação com o que já existe é a FK AdminAudit.adminUserId → User,
--   NO ACTION (apagar usuário não apaga auditoria; o banco recusa);
-- - aplicar como as demais: SQL direto com a DIRECT_URL (sem pooler) ou editor
--   SQL do Supabase; `prisma migrate deploy` não é o caminho deste repositório
--   (ver docs/database.md). Depois rode VERIFICACAO.sql.
-- - reexecutar é inofensivo: IF NOT EXISTS em tudo e FK criada só se faltar.

BEGIN;

CREATE TABLE IF NOT EXISTS "SyncRun" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "job" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "expectedNextAt" TIMESTAMP(3),
  "moviesAdded" INTEGER NOT NULL DEFAULT 0,
  "moviesUpdated" INTEGER NOT NULL DEFAULT 0,
  "seriesAdded" INTEGER NOT NULL DEFAULT 0,
  "seriesUpdated" INTEGER NOT NULL DEFAULT 0,
  "episodesAdded" INTEGER NOT NULL DEFAULT 0,
  "episodesUpdated" INTEGER NOT NULL DEFAULT 0,
  "errors" INTEGER NOT NULL DEFAULT 0,
  "errorSummary" TEXT,
  "heartbeatAt" TIMESTAMP(3),
  CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AdminAudit" (
  "id" TEXT NOT NULL,
  "adminUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "reason" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SyncRun_source_job_startedAt_idx" ON "SyncRun"("source", "job", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "SyncRun_status_startedAt_idx" ON "SyncRun"("status", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "AdminAudit_adminUserId_createdAt_idx" ON "AdminAudit"("adminUserId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AdminAudit_targetType_targetId_createdAt_idx" ON "AdminAudit"("targetType", "targetId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AdminAudit_action_createdAt_idx" ON "AdminAudit"("action", "createdAt" DESC);

DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdminAudit_adminUserId_fkey') THEN
    ALTER TABLE "AdminAudit"
      ADD CONSTRAINT "AdminAudit_adminUserId_fkey"
      FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END
$fk$;

-- Mesma política de 20260812_lock_down_supabase_public_roles: a aplicação só
-- acessa o banco pelo servidor (Prisma). Sem acesso da Data API do Supabase e
-- RLS ligado, sem policy, como defesa em profundidade.
REVOKE ALL PRIVILEGES ON TABLE "SyncRun" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "AdminAudit" FROM anon, authenticated;
ALTER TABLE "SyncRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminAudit" ENABLE ROW LEVEL SECURITY;

COMMIT;
