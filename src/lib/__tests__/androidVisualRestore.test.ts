import assert from "node:assert/strict";
import test from "node:test";
import { ANDROID_NAV_ITEMS } from "@/components/layout/androidNav";
import { paraHero, paraTrilha } from "@/lib/androidHome";

test("a barra Android contém as seis seções solicitadas na ordem final", () => {
  assert.deepEqual(ANDROID_NAV_ITEMS.map((item) => item.label), [
    "Início", "Buscar", "Séries", "Filmes", "Animes", "Kids",
  ]);
});

test("a home preserva logo de cards e todos os destaques com background", () => {
  const item = paraTrilha({ id: "1", titulo: "Teste", logo: "/logo.png", background: "/bg.jpg" }, "filme");
  assert.equal(item.logo, "/logo.png");
  assert.deepEqual(paraHero([
    { id: "1", titulo: "Primeiro", background: "/1.jpg" },
    { id: "2", titulo: "Segundo", background: "/2.jpg" },
  ]).map((hero) => hero.id), ["1", "2"]);
});
