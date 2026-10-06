import { before, test } from "node:test";
import assert from "node:assert/strict";

// Indexação ligada: CONTENT_INDEXING_ENABLED=true. Arquivo separado do teste
// "fechado" de propósito — a const de módulo fixa o valor na primeira carga, e o
// runner do node isola cada arquivo num processo próprio.
let catalogRobots: typeof import("../seo").catalogRobots;
let robots: typeof import("../../app/robots").default;

before(async () => {
  process.env.CONTENT_INDEXING_ENABLED = "true";
  delete process.env.OBAFLIX_SURFACE;
  ({ catalogRobots } = await import("../seo"));
  ({ default: robots } = await import("../../app/robots"));
});

test("fichas passam a index, follow", () => {
  const r = catalogRobots();
  assert.equal((r as { index?: boolean }).index, true);
  assert.equal((r as { follow?: boolean }).follow, true);
});

test("robots libera o catálogo e mantém o player bloqueado", () => {
  const saida = robots();
  const regra = saida.rules;
  const disallow = Array.isArray(regra) ? [] : (regra?.disallow as string[]);
  assert.ok(!disallow.includes("/filme/"), "não deveria bloquear /filme/");
  assert.ok(!disallow.includes("/serie/"), "não deveria bloquear /serie/");
  assert.ok(disallow.includes("/assistir/"), "player continua bloqueado");
  // O sitemap continua anunciado.
  assert.equal(typeof saida.sitemap, "string");
  assert.ok(String(saida.sitemap).endsWith("/sitemap.xml"));
});
