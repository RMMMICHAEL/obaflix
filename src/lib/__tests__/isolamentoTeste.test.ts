import test from "node:test";
import assert from "node:assert/strict";
import { ambienteTesteIsolado } from "../isolamentoTeste";

const base = {
  VERCEL_ENV: "preview", OBAFLIX_AMBIENTE: "teste",
  OBAFLIX_TESTE_DATABASE_URL_UNPOOLED: "postgresql://u:p@ep-teste-1.us-east-1.aws.neon.tech/db",
  DATABASE_URL: "postgresql://u:p@ep-teste-1-pooler.us-east-1.aws.neon.tech/db?pgbouncer=true",
  DIRECT_URL: "postgresql://u:p@ep-teste-1.us-east-1.aws.neon.tech/db",
  OBAFLIX_TESTE_KV_REST_API_URL: "https://teste-1.upstash.io", OBAFLIX_TESTE_KV_REST_API_TOKEN: "t",
  UPSTASH_REDIS_REST_URL: "https://teste-1.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t",
  MONETIZACAO_ATIVA: "false", BLACKCAT_PIX_ATIVO: "false",
};

test("isolado só com banco e Redis do teste, em Preview de teste e sem cobrança", () => {
  assert.equal(ambienteTesteIsolado(base), true);
  assert.equal(ambienteTesteIsolado({ ...base, VERCEL_ENV: "production" }), false);
  assert.equal(ambienteTesteIsolado({ ...base, OBAFLIX_AMBIENTE: undefined }), false);
  assert.equal(ambienteTesteIsolado({ ...base, DATABASE_URL: "postgresql://u:p@ep-prod-9-pooler.aws.neon.tech/db" }), false);
  assert.equal(ambienteTesteIsolado({ ...base, DIRECT_URL: "postgresql://u:p@db.supabase.co/db" }), false);
  assert.equal(ambienteTesteIsolado({ ...base, UPSTASH_REDIS_REST_URL: "https://prod.upstash.io" }), false);
  assert.equal(ambienteTesteIsolado({ ...base, UPSTASH_REDIS_REST_TOKEN: "outro" }), false);
  assert.equal(ambienteTesteIsolado({ ...base, UPSTASH_REDIS_REST_TOKEN: undefined, OBAFLIX_TESTE_KV_REST_API_TOKEN: undefined }), false);
  assert.equal(ambienteTesteIsolado({ ...base, MONETIZACAO_ATIVA: "true" }), false);
  assert.equal(ambienteTesteIsolado({ ...base, OBAFLIX_TESTE_DATABASE_URL_UNPOOLED: "postgresql://u:p@localhost/db", DATABASE_URL: "postgresql://u:p@localhost/db", DIRECT_URL: "postgresql://u:p@localhost/db" }), false);
});
