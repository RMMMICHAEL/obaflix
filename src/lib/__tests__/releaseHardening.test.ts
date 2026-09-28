import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("release móvel e TV carregam as regras compartilhadas de hardening", () => {
  const regras = readFileSync("android/hardening-rules.pro", "utf8");
  assert.match(regras, /-repackageclasses/);
  for (const arquivo of ["android/app/build.gradle", "android/tv/build.gradle"]) {
    assert.match(readFileSync(arquivo, "utf8"), /rootProject\.file\('hardening-rules\.pro'\)/);
  }
});

test("fontes tem limite por conta antes de montar provedores", () => {
  const rota = readFileSync("src/app/api/player/fontes/route.ts", "utf8");
  const limite = rota.indexOf("checkRateLimit(`fontes:${userId}`");
  assert.ok(limite > 0);
  assert.ok(limite < rota.indexOf("const fontes = numerar(montarFontes"));
  assert.match(rota.slice(limite, limite + 600), /status: 429/);
});

test("scripts administrativos não possuem fallback de token", () => {
  // sync-app resolve o token pelo destino compartilhado (legado ou integração).
  const destino = readFileSync("src/lib/catalog-destino.ts", "utf8");
  assert.match(destino, /Sem credencial de catálogo/);
  for (const fonte of [destino, readFileSync("scripts/cleanup-dupes.ts", "utf8")]) {
    assert.doesNotMatch(fonte, /ADMIN_SECRET_TOKEN\s*\?\?/);
    assert.doesNotMatch(fonte, /CATALOG_SYNC_TOKEN\s*\?\?/);
  }
  // Manutenção destrutiva não roda com token HTTP: banco direto, dry-run padrão.
  const cleanup = readFileSync("scripts/cleanup-dupes.ts", "utf8");
  assert.doesNotMatch(cleanup, /x-admin-token|process\.env\.(ADMIN_SECRET_TOKEN|CATALOG_SYNC_TOKEN)|fetch\(/);
  assert.match(cleanup, /const APPLY = process\.argv\.includes\("--apply"\);/);
  const syncApp = readFileSync("scripts/sync-app.ts", "utf8");
  assert.match(syncApp, /resolveCatalogDestino\(\)/);
  assert.doesNotMatch(syncApp, /process\.env\.(ADMIN_SECRET_TOKEN|CATALOG_SYNC_TOKEN)/);
});
