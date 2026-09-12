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
  for (const arquivo of ["scripts/cleanup-dupes.ts", "scripts/sync-app.ts"]) {
    const fonte = readFileSync(arquivo, "utf8");
    assert.match(fonte, /ADMIN_SECRET_TOKEN é obrigatório/);
    assert.doesNotMatch(fonte, /ADMIN_SECRET_TOKEN\s*\?\?/);
  }
});
