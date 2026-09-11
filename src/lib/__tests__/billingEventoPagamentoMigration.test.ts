import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const raiz=path.resolve(process.cwd(),"prisma/migrations/20260910_evento_pagamento");
const sql=fs.readFileSync(path.join(raiz,"migration.sql"),"utf8");
const rollback=fs.readFileSync(path.join(raiz,"ROLLBACK.sql"),"utf8");
test("EventoPagamento preserva idempotência, FK, índices e RLS",()=>{
  for(const trecho of ['CREATE TABLE "EventoPagamento"','"provedor", "transacaoId", "evento", "statusInformado"','FOREIGN KEY ("pedidoId") REFERENCES "PedidoPagamento"','ON DELETE SET NULL','ENABLE ROW LEVEL SECURITY','"EventoPagamento_pedidoId_recebidoEm_idx"','"EventoPagamento_resultado_recebidoEm_idx"']) assert.ok(sql.includes(trecho));
  assert.ok(!/CREATE POLICY|GRANT\s+(SELECT|ALL)/i.test(sql));
});
test("rollback recusa apagar histórico",()=>{assert.match(rollback,/EXISTS \(SELECT 1 FROM "EventoPagamento"\)/);assert.match(rollback,/Rollback recusado/)});
