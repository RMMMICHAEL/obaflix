import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const SCHEMA = readFileSync("prisma/schema.prisma", "utf8");
const SET_NULL = readFileSync(
  "prisma/migrations/20261012120000_admin_audit_user_set_null/migration.sql",
  "utf8",
);
const OBS = readFileSync(
  "prisma/migrations/20260928150000_admin_surface_observability/migration.sql",
  "utf8",
);
const semComentario = (sql: string) => sql.replace(/--.*$/gm, "");

// Bloco `model AdminAudit { ... }` isolado do resto do schema.
const adminAuditModel = (() => {
  const start = SCHEMA.indexOf("model AdminAudit {");
  assert.notEqual(start, -1, "model AdminAudit não encontrado no schema");
  return SCHEMA.slice(start, SCHEMA.indexOf("}", start) + 1);
})();

test("schema: ator da auditoria é opcional e apaga com SET NULL, não Cascade", () => {
  assert.match(adminAuditModel, /adminUserId\s+String\?/, "adminUserId deve ser anulável");
  assert.match(
    adminAuditModel,
    /adminUser\s+User\?\s+@relation\(fields:\s*\[adminUserId\],\s*references:\s*\[id\],\s*onDelete:\s*SetNull\)/,
    "relação opcional com onDelete: SetNull",
  );
  assert.doesNotMatch(adminAuditModel, /onDelete:\s*Cascade/, "nunca Cascade na auditoria");
  // Campos imutáveis do registro continuam presentes.
  for (const campo of ["action", "targetType", "targetId", "reason", "metadata", "createdAt"]) {
    assert.match(adminAuditModel, new RegExp(`\\b${campo}\\b`), `campo ${campo} preservado`);
  }
});

test("migration SET NULL: só desvincula o ator, nunca apaga/edita linha de auditoria", () => {
  const sql = semComentario(SET_NULL);
  assert.match(SET_NULL, /^\s*BEGIN;/m);
  assert.match(SET_NULL, /^\s*COMMIT;\s*$/m);
  // Torna a coluna anulável e usa o nome real da FK descoberto na migration original.
  assert.match(sql, /ALTER TABLE "AdminAudit" ALTER COLUMN "adminUserId" DROP NOT NULL/);
  assert.match(sql, /DROP CONSTRAINT "AdminAudit_adminUserId_fkey"/);
  assert.match(
    sql,
    /ADD CONSTRAINT "AdminAudit_adminUserId_fkey"\s+FOREIGN KEY \("adminUserId"\) REFERENCES "User"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
  );
  // Sem apagar conteúdo histórico nem converter linhas à mão.
  const semAcoesFk = sql.replace(/ON (DELETE|UPDATE) (NO ACTION|CASCADE|RESTRICT|SET NULL)/gi, "");
  assert.doesNotMatch(semAcoesFk, /\b(DELETE|TRUNCATE)\b/i, "não apaga linhas de auditoria");
  assert.doesNotMatch(semAcoesFk, /DROP TABLE|CASCADE/i, "não dropa tabela nem usa Cascade");
  assert.doesNotMatch(sql, /UPDATE "AdminAudit"/i, "não converte linhas existentes para NULL");
});

test("migration original intocada: continua NO ACTION (não editamos migration aplicada)", () => {
  assert.match(OBS, /ON DELETE NO ACTION/);
  assert.match(OBS, /adminUserId" TEXT NOT NULL/);
});

test("leitor de auditoria: ator nulo vira rótulo neutro, sem inventar dados", () => {
  const page = readFileSync("src/app/admin/page.tsx", "utf8");
  // Não há mais acesso incondicional a item.adminUser.nome.
  assert.doesNotMatch(page, /\{item\.adminUser\.nome/);
  // Guarda de nulo + rótulo neutro, sem PII fabricada.
  assert.match(page, /item\.adminUser\s*\?/);
  assert.match(page, /Conta administrativa excluída/);
});

test("escrita normal preservada: auditoria lê o ator e grava adminUserId válido", () => {
  const rota = readFileSync("src/app/api/admin/auditoria/route.ts", "utf8");
  assert.match(rota, /include:\s*\{\s*adminUser:/, "reader ainda inclui o ator (null quando apagado)");
  const acao = readFileSync("src/lib/admin-action.ts", "utf8");
  assert.match(acao, /adminUserId:\s*args\.adminUserId/, "criação continua com adminUserId válido");
});
