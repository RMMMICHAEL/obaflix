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

test("robots bloqueia TODO o catálogo público enquanto a indexação está desligada", () => {
  const regra = robots().rules;
  const disallow = Array.isArray(regra) ? [] : (regra?.disallow as string[]);
  // As cinco famílias públicas da Fase 2: fichas, listagens e gêneros.
  for (const rota of ["/filme/", "/serie/", "/filmes", "/series", "/genero/"]) {
    assert.ok(disallow.includes(rota), `deveria bloquear ${rota}`);
  }
  // Player e reprodução nunca são anunciáveis, em qualquer flag.
  assert.ok(disallow.includes("/assistir/"));
  assert.ok(disallow.includes("/player/"));
});
