import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Fase Velocidade 1A.3 — os links internos de "conteúdos parecidos" precisam
 * nascer no HTML inicial (ISR), sem recolocar getTVRecommendations no ISR. Trava
 * contra a regressão de SEO da 1A.2 (recs só após fetch cliente).
 */
const ler = (p: string) => readFileSync(p, "utf8");
const semBloco = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "");
const page = () => ler("src/app/serie/[id]/page.tsx");
const recsClient = () => ler("src/app/serie/[id]/SerieRecomendacoesClient.tsx");

test("page.tsx monta baseline LOCAL de recomendações por gênero (Prisma, sem TMDB)", () => {
  const src = page();
  // Consulta local por gênero, excluindo a própria série, teto 20, só campos de card.
  assert.match(src, /prisma\.serie\.findMany\(\{\s*where: \{ id: \{ not: serie\.id \}, generos: \{ some: \{ generoId: \{ in: generoIds \} \} \} \}/);
  assert.match(src, /take: 20/);
  assert.match(src, /select: \{ id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true, tipo: true \}/);
  // Roda dentro do Promise.all crítico (paralela), não numa fase sequencial nova.
  assert.match(src, /const \[episodios, videos, certificacao, images, recomendacoesLocais\] = await Promise\.all\(/);
  // Sem COUNT.
  assert.doesNotMatch(src, /prisma\.serie\.count/);
});

test("page.tsx passa initialItems ao SerieRecomendacoesClient (SSR/ISR)", () => {
  assert.match(page(), /<SerieRecomendacoesClient[\s\S]*?initialItems=\{recomendacoesIniciais\}[\s\S]*?\/>/);
});

test("SerieRecomendacoesClient inicializa o estado com initialItems e renderiza antes do fetch", () => {
  const src = recsClient();
  assert.match(src, /initialItems\??\s*=\s*\[\]/); // prop com default
  assert.match(src, /useState<any\[\]>\(initialItems\)/);
  // A LandscapeRow é renderizada com `items` (semeado por initialItems), não
  // condicionada ao término do fetch.
  assert.match(src, /if \(!items\.length\) return null/);
  assert.match(src, /<LandscapeRow titulo=\{`Conteúdos parecidos com \$\{serieTitulo\}`\} items=\{items\}/);
});

test("o fetch só MELHORA: lista válida/não-vazia substitui; falha mantém baseline", () => {
  const src = recsClient();
  assert.match(src, /if \(Array\.isArray\(d\.items\) && d\.items\.length\) setItems\(d\.items\)/);
  // No catch não há setItems — a baseline local permanece.
  const cat = src.slice(src.indexOf(".catch("));
  assert.doesNotMatch(cat, /setItems/);
});

test("links relacionados continuam sendo LandscapeCard → Link (cadeia real)", () => {
  assert.match(recsClient(), /<LandscapeRow/);
  const row = ler("src/components/ui/LandscapeRow.tsx");
  assert.match(row, /<LandscapeCard/);
  const card = ler("src/components/ui/LandscapeCard.tsx");
  assert.match(card, /<Link href=/);
});

test("sem cloaking: nada de lista sr-only/display:none/hidden só para crawler", () => {
  const src = recsClient();
  assert.doesNotMatch(src, /sr-only|display:\s*none|hidden/i);
});

test("getTVRecommendations NÃO está no page.tsx; getTVCredits/getSerie também fora", () => {
  const src = semBloco(page());
  assert.doesNotMatch(src, /getTVRecommendations/);
  assert.doesNotMatch(src, /getTVCredits/);
  assert.doesNotMatch(src, /getSerie\b/);
});
