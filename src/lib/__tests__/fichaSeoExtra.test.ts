import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * FichaSeoExtra é server component com JSX e next/link; o runner (node:test, sem
 * jsdom, JSX clássico) não o renderiza. Travas de fonte garantem heading, copy
 * de "no aplicativo" e as quatro frases de disponibilidade derivadas de booleanos.
 */
const src = readFileSync("src/components/catalog/FichaSeoExtra.tsx", "utf8");

test("heading orientado à intenção: 'Onde assistir <Título> online'", () => {
  assert.match(src, /Onde assistir \{titulo\} online/);
});

test("copy do filme deixa claro que a reprodução é no aplicativo", () => {
  assert.match(src, /Para assistir \$\{titulo\} online, use o aplicativo Obaflix/);
  assert.match(src, /Nesta página você encontra sinopse, elenco, gêneros/);
});

test("copy da série fala de episódios e do aplicativo", () => {
  assert.match(src, /Para assistir \$\{titulo\} online e acompanhar seus episódios/);
  assert.match(src, /temporadas, episódios, elenco/);
});

test("disponibilidade: as quatro combinações de dub/leg", () => {
  assert.match(src, /opções dublada e legendada\./);
  assert.match(src, /opção dublada\./);
  assert.match(src, /opção legendada\./);
  // "nenhum" não gera frase: o ramo final é null.
  assert.match(src, /:\s*null;/);
});

test("disponibilidade é derivada de booleanos (dub/leg), nunca de URL", () => {
  assert.match(src, /dub = false,\s*\n\s*leg = false,/);
  assert.match(src, /dub && leg/);
  // O componente não conhece nenhuma URL de mídia.
  assert.doesNotMatch(src, /urlDub|urlLeg/);
});
