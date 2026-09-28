import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const OBS = readFileSync("prisma/migrations/20260928150000_admin_surface_observability/migration.sql", "utf8");
const FOUND = readFileSync("prisma/migrations/20260929120000_sync_run_found/migration.sql", "utf8");
const semComentario = (sql: string) => sql.replace(/--.*$/gm, "");

test("migrations do Admin são aditivas: nada de DROP, DELETE, TRUNCATE ou UPDATE", () => {
  // Ações referenciais da FK ("ON DELETE NO ACTION ON UPDATE CASCADE") não são comandos.
  const semAcoesFk = (sql: string) => sql.replace(/ON (DELETE|UPDATE) (NO ACTION|CASCADE|RESTRICT|SET NULL)/gi, "");
  for (const sql of [OBS, FOUND].map(semComentario).map(semAcoesFk)) {
    assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b|ALTER\s+COLUMN/i);
  }
});

test("migrations do Admin seguem o padrão do repositório: transação e idempotência", () => {
  for (const sql of [OBS, FOUND].map(semComentario)) {
    assert.match(sql, /^\s*BEGIN;/m);
    assert.match(sql, /^\s*COMMIT;\s*$/m);
  }
  assert.equal((semComentario(OBS).match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 2);
  assert.doesNotMatch(semComentario(OBS), /CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/);
  assert.match(FOUND, /ADD COLUMN IF NOT EXISTS "found" INTEGER;/);
});

test("tabelas novas sem acesso da Data API do Supabase: REVOKE + RLS, sem policy", () => {
  for (const tabela of ["SyncRun", "AdminAudit"]) {
    assert.match(OBS, new RegExp(`REVOKE ALL PRIVILEGES ON TABLE "${tabela}" FROM anon, authenticated;`));
    assert.match(OBS, new RegExp(`ALTER TABLE "${tabela}" ENABLE ROW LEVEL SECURITY;`));
  }
  assert.doesNotMatch(semComentario(OBS), /CREATE POLICY|GRANT /i);
  assert.match(OBS, /ON DELETE NO ACTION/);
});
