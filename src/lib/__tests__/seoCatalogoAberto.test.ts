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

test("robots libera TODO o catálogo público e mantém o player bloqueado", () => {
  const saida = robots();
  const regra = saida.rules;
  const disallow = Array.isArray(regra) ? [] : (regra?.disallow as string[]);
  // Nenhuma das cinco famílias de catálogo pode permanecer no Disallow.
  for (const rota of ["/filme/", "/serie/", "/filmes", "/series", "/genero/"]) {
    assert.ok(!disallow.includes(rota), `não deveria bloquear ${rota}`);
  }
  // Player e reprodução continuam bloqueados mesmo com a flag ligada.
  assert.ok(disallow.includes("/assistir/"), "player continua bloqueado");
  assert.ok(disallow.includes("/player/"), "player continua bloqueado");
  // O sitemap continua anunciado.
  assert.equal(typeof saida.sitemap, "string");
  assert.ok(String(saida.sitemap).endsWith("/sitemap.xml"));
});
