import { test } from "node:test";
import assert from "node:assert/strict";

import { generateMetadata as filmesMeta } from "../../app/filmes/page";
import { generateMetadata as seriesMeta } from "../../app/series/page";
import { detectarAmbiente } from "@/config/site-mode";

/**
 * Variantes com search param de /filmes e /series não podem virar páginas SEO
 * duplicadas (a versão pública ignora os parâmetros). Sem param, herda o layout.
 */

test("/filmes: sem params não sobrescreve metadata (herda o layout indexável)", () => {
  assert.deepEqual(filmesMeta({ searchParams: {} }), {});
});

test("/filmes: com qualquer param → noindex, follow + canonical /filmes", () => {
  for (const sp of [{ ordem: "popular" }, { q: "x" }, { page: "2" }, { genero: "18" }]) {
    const md = filmesMeta({ searchParams: sp }) as any;
    assert.equal(md.robots.index, false, JSON.stringify(sp));
    assert.equal(md.robots.follow, true);
    assert.equal(md.alternates.canonical, "/filmes");
  }
});

test("/series: mesmo contrato, canonical /series", () => {
  assert.deepEqual(seriesMeta({ searchParams: {} }), {});
  const md = seriesMeta({ searchParams: { page: "2", genero: "18" } }) as any;
  assert.equal(md.robots.index, false);
  assert.equal(md.robots.follow, true);
  assert.equal(md.alternates.canonical, "/series");
});

test("Android/Electron não recebem a versão pública (ambiente != navegador)", () => {
  // O branch da página só entrega CatalogoPublico para navegador; os apps caem
  // no caminho homologado. A metadata noindex é só SEO e não toca nisso.
  assert.equal(detectarAmbiente("Mozilla/5.0 ObaflixApp/1.0.10", null), "android");
  assert.equal(detectarAmbiente("Mozilla/5.0 ObaflixDesktop/1.0.12", null), "desktop");
  assert.equal(detectarAmbiente("Mozilla/5.0 Chrome/120", null), "navegador");
});
