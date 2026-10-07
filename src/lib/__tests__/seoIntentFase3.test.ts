import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Travas de fonte da Fase 3 (H1 e não-vazamento de URL), que exigiriam render de
 * client component com contexto / banco para serem verificadas em runtime.
 */
const ler = (p: string) => readFileSync(p, "utf8");

test("MediaHero: exatamente um H1", () => {
  const src = ler("src/components/ui/MediaHero.tsx");
  const n = (src.match(/<h1[\s>]/g) ?? []).length;
  assert.equal(n, 1, "deve haver exatamente um <h1>");
});

test("MediaHero: heading é texto visível no H1, nunca sr-only", () => {
  const src = ler("src/components/ui/MediaHero.tsx");
  // Renderiza o heading como texto real (logo + linha visível, ou título grande).
  assert.ok(src.includes("{heading ?? titulo}"), "o H1 deve renderizar o heading visível");
  // O padrão antigo de esconder o título no H1 não existe mais.
  assert.doesNotMatch(src, /sr-only">\{titulo\}/);
});

test("fichas passam heading 'Assistir <Título> online' ao MediaHero", () => {
  const filme = ler("src/app/filme/[id]/page.tsx");
  const serie = ler("src/app/serie/[id]/page.tsx");
  assert.ok(filme.includes("heading={`Assistir ${filme.titulo} online`}"));
  assert.ok(serie.includes("heading={`Assistir ${serie.titulo} online`}"));
});

test("série: só booleanos de áudio saem do servidor (urlDub/urlLeg nunca ao client)", () => {
  const serie = ler("src/app/serie/[id]/page.tsx");
  // As URLs são descartadas antes de montar o payload público dos episódios.
  assert.match(serie, /episodios\.map\(\(\{ urlDub, urlLeg, \.\.\.ep \}\)/);
  // A disponibilidade é derivada dos booleanos já públicos, não das URLs.
  assert.match(serie, /temDub = episodiosPublicos\.some\(\(e\) => e\.dub\)/);
  assert.match(serie, /temLeg = episodiosPublicos\.some\(\(e\) => e\.leg\)/);
  // FichaSeoExtra recebe apenas os booleanos.
  assert.match(serie, /dub=\{temDub\} leg=\{temLeg\}/);
});
