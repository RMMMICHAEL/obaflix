-- Exclusão de conta que já foi administradora, sem apagar a auditoria imutável.
--
-- IMPORTANTE:
-- - só estrutura: torna AdminAudit.adminUserId anulável e troca a FK
--   NO ACTION pela equivalente ON DELETE SET NULL (ON UPDATE CASCADE mantido);
-- - NÃO apaga, NÃO edita e NÃO reescreve nenhuma linha de auditoria; a conversão
--   para NULL só acontece quando o User referenciado for realmente apagado;
-- - não é Cascade: action, targetType, targetId, reason, metadata e createdAt
--   ficam intactos; apenas o vínculo com o ator apagado some;
-- - administrador atual continua impedido de se autoexcluir (regra da PR #73);
--   esta migration só remove o bloqueio estrutural para contas já rebaixadas;
-- - aplicar como as demais: SQL direto com a DIRECT_URL (sem pooler) ou editor
--   SQL do Supabase; `prisma migrate deploy` não é o caminho deste repositório
--   (ver docs/database.md).
-- - reexecutar é inofensivo: DROP NOT NULL é no-op se já anulável e a FK é
--   recriada a partir do nome real descoberto na migration que criou a tabela
--   (20260928150000_admin_surface_observability: "AdminAudit_adminUserId_fkey").

BEGIN;

-- Ator passa a aceitar NULL: ex-admin apagado desvincula sem derrubar o registro.
ALTER TABLE "AdminAudit" ALTER COLUMN "adminUserId" DROP NOT NULL;

-- Substitui a FK NO ACTION pela SET NULL, preservando ON UPDATE CASCADE.
DO $fk$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdminAudit_adminUserId_fkey') THEN
    ALTER TABLE "AdminAudit" DROP CONSTRAINT "AdminAudit_adminUserId_fkey";
  END IF;
  ALTER TABLE "AdminAudit"
    ADD CONSTRAINT "AdminAudit_adminUserId_fkey"
    FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
END
$fk$;

COMMIT;
