import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Travas da rodada de revisão da Fase 2. São asserções de fonte (mesmo padrão
 * de bannerDesktop/androidMedia): fixam decisões que, de outro modo, exigiriam
 * banco para serem verificadas em runtime.
 */
const ler = (p: string) => readFileSync(p, "utf8");

test("sitemap paginas.xml: anuncia /filmes e /series, nunca /animes, /desenhos, /melhores", () => {
  const src = ler("src/app/sitemap/[shard]/route.ts");
  assert.match(src, /absoluteUrl\("\/filmes"\)/);
  assert.match(src, /absoluteUrl\("\/series"\)/);
  assert.doesNotMatch(src, /"\/animes"/);
  assert.doesNotMatch(src, /"\/desenhos"/);
  assert.doesNotMatch(src, /"\/melhores"/);
});

test("sitemap: só gêneros com conteúdo disponível, numa única consulta (sem N+1)", () => {
  const src = ler("src/app/sitemap/[shard]/route.ts");
  assert.match(src, /filmeDisponivel\(\)/);
  assert.match(src, /serieDisponivel\(\)/);
  const consultas = src.match(/prisma\.genero\.findMany/g) ?? [];
  assert.equal(consultas.length, 1, "deve haver exatamente uma consulta de gêneros");
});

test("home: links reais 'Ver todos' para /filmes e /series; nada para /animes", () => {
  const landing = ler("src/components/landing/LandingPage.tsx");
  assert.match(landing, /verTodosHref="\/filmes"/);
  assert.match(landing, /verTodosHref="\/series"/);
  assert.doesNotMatch(landing, /verTodosHref="\/animes"/);
  const vitrine = ler("src/components/landing/Vitrine.tsx");
  assert.match(vitrine, /verTodosHref/);
  assert.match(vitrine, /Ver todos/);
});

test("breadcrumb do filme inclui o degrau /filmes (visual e JSON-LD)", () => {
  const src = ler("src/app/filme/[id]/page.tsx");
  assert.match(src, /name: "Filmes", item: absoluteUrl\("\/filmes"\)/);
  assert.match(src, /label: "Filmes", href: "\/filmes"/);
});

test("breadcrumb da série pura inclui /series; anime/desenho não aponta rota fechada", () => {
  const src = ler("src/app/serie/[id]/page.tsx");
  assert.match(src, /ehSeriePura/);
  assert.match(src, /absoluteUrl\("\/series"\)/);
  assert.doesNotMatch(src, /"\/animes"/);
  assert.doesNotMatch(src, /"\/desenhos"/);
});

test("genero: responde 404 quando a página não tem conteúdo", () => {
  const src = ler("src/app/genero/[id]/page.tsx");
  assert.match(src, /itens\.length === 0\)\s*notFound\(\)/);
});
