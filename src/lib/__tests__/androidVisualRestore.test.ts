import assert from "node:assert/strict";
import test from "node:test";
import { ANDROID_NAV_ITEMS } from "@/components/layout/androidNav";
import { paraHero, paraTrilha } from "@/lib/androidHome";

/**
 * A barra ganhou "Canais" como sétima entrada, e este teste foi atualizado de
 * propósito junto com ela: a ordem é decisão de produto, e o teste existe para
 * uma mudança nela ser sempre deliberada — nunca um efeito colateral.
 *
 * As seis originais continuam todas presentes e na mesma ordem relativa.
 * Nenhuma seção foi removida para abrir espaço.
 */
test("a barra Android contém as sete seções na ordem final", () => {
  assert.deepEqual(ANDROID_NAV_ITEMS.map((item) => item.label), [
    "Início", "Buscar", "Séries", "Filmes", "Canais", "Animes", "Kids",
  ]);
});

test("a barra Android não perdeu nenhuma das seis seções originais", () => {
  const rotulos = ANDROID_NAV_ITEMS.map((item) => item.label);
  for (const original of ["Início", "Buscar", "Séries", "Filmes", "Animes", "Kids"]) {
    assert.ok(rotulos.includes(original), `sumiu a seção "${original}"`);
  }
});

test("a home preserva logo de cards e todos os destaques com background", () => {
  const item = paraTrilha({ id: "1", titulo: "Teste", logo: "/logo.png", background: "/bg.jpg" }, "filme");
  assert.equal(item.logo, "/logo.png");
  assert.deepEqual(paraHero([
    { id: "1", titulo: "Primeiro", background: "/1.jpg" },
    { id: "2", titulo: "Segundo", background: "/2.jpg" },
  ]).map((hero) => hero.id), ["1", "2"]);
});
