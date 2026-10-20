import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const cta = read("../../components/landing/AndroidDownloadCta.tsx");
const analytics = read("../marketing/landing-analytics.ts");
const metrics = read("../marketing/landing-metrics.ts");
const migration = read("../../../prisma/migrations/20261008_marketing_landing_metric/migration.sql");

test("cliente não cria cookie, storage, identificador nem pixel", () => {
  // Uso real das APIs (não a prosa dos comentários, que legitimamente as cita).
  for (const src of [cta, analytics]) {
    assert.doesNotMatch(src, /document\.cookie|localStorage\s*[.[]|sessionStorage\s*[.[]|\.setItem\(|new Image\(|fingerprint/i);
    assert.doesNotMatch(src, /userId|advertisingId|deviceId/);
  }
});

test("analytics é fail-open com sendBeacon e fetch keepalive", () => {
  assert.match(analytics, /navigator\.sendBeacon/);
  assert.match(analytics, /keepalive:\s*true/);
  assert.match(analytics, /catch\s*\{/); // engole qualquer erro
});

test("landing_view dispara uma vez e só no CTA hero", () => {
  assert.match(cta, /variant === "hero" && !viewEnviado\.current/);
  assert.match(cta, /event:\s*"landing_view"/);
  // cliques cobrem os dois eventos e os três placements.
  assert.match(cta, /event:\s*"open_external_browser_click"/);
  assert.match(cta, /event:\s*"android_download_click"/);
  assert.match(cta, /variant === "hero" \? "hero" : variant === "bar" \? "bar" : "final"/);
});

test("a âncora de download não é interceptada (navegação não é bloqueada)", () => {
  // Nenhum preventDefault na âncora: o clique segue para /download/android.
  assert.doesNotMatch(cta, /preventDefault/);
});

test("storage agregado não tem coluna de PII", () => {
  // Checa identificadores de COLUNA (entre aspas), não a prosa dos comentários.
  const colunaPii = /"(userId|sessionId|ip|ipAddress|userAgent|fingerprint|referrer|advertisingId|deviceId|email)"/i;
  assert.doesNotMatch(migration, colunaPii);
  // Colunas existentes são só as agregadas.
  assert.deepEqual(
    [...migration.matchAll(/^\s{4}"(\w+)"\s/gm)].map((m) => m[1]),
    ["id", "day", "event", "context", "placement", "source", "medium", "campaign", "content", "count", "createdAt", "updatedAt"],
  );
  // a leitura agregada não seleciona nada de PII
  assert.doesNotMatch(metrics, /\b(userId|sessionId|ipAddress|userAgent|fingerprint|advertisingId|deviceId)\b/);
  // a migration cria a tabela agregada e liga RLS
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "MarketingLandingMetric"/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
});
