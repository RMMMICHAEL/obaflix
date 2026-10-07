import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fatiarPagina, takeComSonda } from "@/lib/paginacao";

const POR_PAGINA = 30;

/**
 * Simula o que uma consulta `skip/take: POR_PAGINA + 1` devolve contra um pool de
 * `total` linhas: `clamp(total - skip, 0, POR_PAGINA + 1)`. É exatamente o que o
 * Prisma retornaria, sem COUNT. Devolve um array de ids crescentes só para o
 * comprimento importar.
 */
function consultar(total: number, page: number): number[] {
  const skip = (page - 1) * POR_PAGINA;
  const n = Math.max(0, Math.min(takeComSonda(POR_PAGINA), total - skip));
  return Array.from({ length: n }, (_, i) => skip + i + 1);
}

test("takeComSonda busca POR_PAGINA + 1 (a sonda), nunca POR_PAGINA", () => {
  assert.equal(takeComSonda(POR_PAGINA), 31);
});

test("exatamente 30 itens ⇒ página cheia, sem Próxima", () => {
  const filmes = consultar(30, 1);
  const r = fatiarPagina(filmes, [], POR_PAGINA);
  assert.equal(filmes.length, 30, "a sonda não trouxe linha extra");
  assert.equal(r.filmes.length, 30, "renderiza os 30");
  assert.equal(r.temProxima, false);
});

test("31 itens ⇒ renderiza 30 e oferece Próxima", () => {
  const filmes = consultar(31, 1);
  const r = fatiarPagina(filmes, [], POR_PAGINA);
  assert.equal(filmes.length, 31, "a sonda trouxe a 31ª linha");
  assert.equal(r.filmes.length, 30, "descarta a sonda ao exibir");
  assert.equal(r.temProxima, true);
});

test("exatamente 60 itens ⇒ página 2 cheia, sem Próxima", () => {
  const filmes = consultar(60, 2);
  const r = fatiarPagina(filmes, [], POR_PAGINA);
  assert.equal(filmes.length, 30);
  assert.equal(r.filmes.length, 30);
  assert.equal(r.temProxima, false);
});

test("61 itens ⇒ página 2 renderiza 30 e oferece Próxima", () => {
  const filmes = consultar(61, 2);
  const r = fatiarPagina(filmes, [], POR_PAGINA);
  assert.equal(filmes.length, 31);
  assert.equal(r.filmes.length, 30);
  assert.equal(r.temProxima, true);
});

test("página além do fim volta vazia ⇒ a página responde 404 (itens.length === 0)", () => {
  // 60 no total; page 3 (skip 60) não alcança nada.
  const filmes = consultar(60, 3);
  const series = consultar(0, 3);
  const r = fatiarPagina(filmes, series, POR_PAGINA);
  assert.equal(r.filmes.length, 0);
  assert.equal(r.series.length, 0);
  assert.equal(r.filmes.length + r.series.length, 0, "sem itens ⇒ notFound()");
  assert.equal(r.temProxima, false);
});

test("Próxima dispara por qualquer um dos lados (filmes OU séries)", () => {
  // Filmes exatamente cheios, séries com sonda.
  const r = fatiarPagina(consultar(30, 1), consultar(31, 1), POR_PAGINA);
  assert.equal(r.filmes.length, 30);
  assert.equal(r.series.length, 30);
  assert.equal(r.temProxima, true);
});

test("a página de gênero realmente usa takeComSonda + fatiarPagina (sem COUNT)", () => {
  const src = readFileSync("src/app/genero/[id]/page.tsx", "utf8");
  assert.match(src, /take: takeComSonda\(POR_PAGINA\)/);
  assert.match(src, /fatiarPagina\(\s*filmesCru,\s*seriesCru,\s*POR_PAGINA,?\s*\)/);
  // skip segue baseado em POR_PAGINA, nunca na sonda (+1).
  assert.match(src, /const skip = \(page - 1\) \* POR_PAGINA/);
  assert.doesNotMatch(src, /\.count\(/);
  // O falso positivo antigo (length === POR_PAGINA) não existe mais.
  assert.doesNotMatch(src, /length === POR_PAGINA/);
});

test("skip permanece múltiplo de POR_PAGINA (a sonda não desloca a página seguinte)", () => {
  // A 2ª página começa em 31 (skip 30 + 1), não em 32: a sonda da 1ª página (id
  // 31) reaparece como 1º item real da 2ª, sem buraco nem sobreposição deslocada.
  const p1 = consultar(100, 1); // ids 1..31 (30 exibidos + sonda 31)
  const p2 = consultar(100, 2); // ids 31..61
  assert.equal(p1[POR_PAGINA], 31, "sonda da página 1");
  assert.equal(p2[0], 31, "página 2 começa no id 31 (skip = 30)");
});
