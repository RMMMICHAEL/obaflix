import { test } from "node:test";
import assert from "node:assert/strict";

import { tituloFicha, descricaoFicha, cleanDescription } from "@/lib/seo";

test("título do filme: intenção 'assistir online' com e sem ano", () => {
  assert.equal(
    tituloFicha("filme", "Oppenheimer", 2023),
    "Assistir Oppenheimer online (2023) — onde assistir",
  );
  assert.equal(
    tituloFicha("filme", "Oppenheimer"),
    "Assistir Oppenheimer online — onde assistir",
  );
  assert.match(tituloFicha("filme", "Oppenheimer", 2023), /Assistir Oppenheimer online/);
});

test("título da série: 'assistir online — temporadas e episódios'", () => {
  assert.equal(tituloFicha("serie", "Dexter"), "Assistir Dexter online — temporadas e episódios");
  assert.match(tituloFicha("serie", "Dexter"), /Assistir Dexter online/);
});

test("description: intenção + Obaflix + sinopse quando existe", () => {
  const d = descricaoFicha("filme", "Oppenheimer", "A história de Robert Oppenheimer.");
  assert.match(d, /assistir Oppenheimer online/);
  assert.match(d, /Obaflix/);
  assert.match(d, /A história de Robert Oppenheimer\./);

  const serie = descricaoFicha("serie", "Dexter", "Um analista forense serial killer.");
  assert.match(serie, /assistir Dexter online/);
  assert.match(serie, /temporadas, episódios/);
  assert.match(serie, /Um analista forense serial killer\./);
});

test("description sem sinopse: só a parte de intenção, sem inventar conteúdo", () => {
  const d = descricaoFicha("filme", "Oppenheimer", null);
  assert.match(d, /Quer assistir Oppenheimer online\?/);
  assert.match(d, /Obaflix/);
  assert.doesNotMatch(d, /undefined|null/);
});

test("respeita o comportamento de cleanDescription (limite + reticências)", () => {
  const longa = "x".repeat(400);
  const out = cleanDescription(descricaoFicha("filme", "Oppenheimer", longa));
  assert.ok(out.length <= 156, `tamanho ${out.length}`);
  assert.ok(out.endsWith("…"));
  // Curta: cabe inteira, sem reticências.
  const curta = cleanDescription(descricaoFicha("serie", "Dexter", "Curta."));
  assert.ok(!curta.endsWith("…"));
  assert.match(curta, /Curta\./);
});
