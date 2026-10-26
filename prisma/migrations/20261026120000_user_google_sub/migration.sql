-- Identidade estável do login Google (`sub`) em User.
--
-- Só estrutura, aditiva e idempotente: uma coluna anulável e um índice único. NÃO apaga, NÃO edita e NÃO reescreve
-- nenhuma linha; contas existentes ficam com googleSub NULL até o primeiro login Google do titular.
-- Índice único sobre coluna toda NULL é instantâneo (vários NULL são permitidos).
-- Aplicar como as demais: SQL direto com a DIRECT_URL (sem pooler).
--
-- Reversão: DROP INDEX IF EXISTS "User_googleSub_key"; ALTER TABLE "User" DROP COLUMN IF EXISTS "googleSub";

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_googleSub_key" ON "User"("googleSub");
