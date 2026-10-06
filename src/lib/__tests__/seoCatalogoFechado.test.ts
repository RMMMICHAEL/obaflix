import { before, test } from "node:test";
import assert from "node:assert/strict";

// Rollout fechado: CONTENT_INDEXING_ENABLED ausente/false. Definido antes do
// import porque `catalogIndexingEnabled` é const de módulo, avaliada na carga.
let catalogRobots: typeof import("../seo").catalogRobots;
let robots: typeof import("../../app/robots").default;

before(async () => {
  delete process.env.CONTENT_INDEXING_ENABLED;
  delete process.env.OBAFLIX_SURFACE;
  ({ catalogRobots } = await import("../seo"));
  ({ default: robots } = await import("../../app/robots"));
});

test("fichas respondem noindex, follow", () => {
  assert.deepEqual(catalogRobots(), { index: false, follow: true });
});

test("robots bloqueia o catálogo enquanto a indexação está desligada", () => {
  const regra = robots().rules;
  const disallow = Array.isArray(regra) ? [] : (regra?.disallow as string[]);
  assert.ok(disallow.includes("/filme/"), "deveria bloquear /filme/");
  assert.ok(disallow.includes("/serie/"), "deveria bloquear /serie/");
  // O player nunca é anunciável.
  assert.ok(disallow.includes("/assistir/"));
});
