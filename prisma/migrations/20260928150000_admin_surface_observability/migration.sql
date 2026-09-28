-- Additive-only migration for the separated administrative surface.
CREATE TABLE "SyncRun" (
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

CREATE TABLE "AdminAudit" (
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

CREATE INDEX "SyncRun_source_job_startedAt_idx" ON "SyncRun"("source", "job", "startedAt" DESC);
CREATE INDEX "SyncRun_status_startedAt_idx" ON "SyncRun"("status", "startedAt" DESC);
CREATE INDEX "AdminAudit_adminUserId_createdAt_idx" ON "AdminAudit"("adminUserId", "createdAt" DESC);
CREATE INDEX "AdminAudit_targetType_targetId_createdAt_idx" ON "AdminAudit"("targetType", "targetId", "createdAt" DESC);
CREATE INDEX "AdminAudit_action_createdAt_idx" ON "AdminAudit"("action", "createdAt" DESC);
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
