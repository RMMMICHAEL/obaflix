import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { heroBackdropSrc, heroBackdropSrcSet } from "../tmdb-image";

/**
 * Fase Velocidade 1B — backdrop responsivo do hero.
 *
 * images.unoptimized é GLOBAL e vence unoptimized={false} por imagem (o Next
 * força unoptimized = true e serve o src cru sem srcset). Por isso o hero monta
 * o srcset à mão num <img>, fora do alcance da flag. Estes testes travam a forma
 * do srcset; a prova de currentSrc real em navegador vai no relatório da PR.
 */

const ler = (p: string) => readFileSync(p, "utf8");

const BASE = "https://image.tmdb.org/t/p";

test("heroBackdropSrcSet lista w780, w1280 e original com descritores de largura reais", () => {
  assert.equal(
    heroBackdropSrcSet("/abc.jpg"),
    `${BASE}/w780/abc.jpg 780w, ${BASE}/w1280/abc.jpg 1280w, ${BASE}/original/abc.jpg 3840w`,
  );
  // Caminho sem barra inicial ainda resolve.
  assert.equal(
    heroBackdropSrcSet("abc.jpg"),
    `${BASE}/w780/abc.jpg 780w, ${BASE}/w1280/abc.jpg 1280w, ${BASE}/original/abc.jpg 3840w`,
  );
});

test("mobile nunca escolhe 'original': só o candidato de 3840w carrega original", () => {
  const srcset = heroBackdropSrcSet("/abc.jpg")!;
  const entries = srcset.split(", ").map((e) => {
    const [url, desc] = e.split(" ");
    return { url, width: Number(desc.replace("w", "")) };
  });
  // Todo candidato com descritor <= 1280 (o teto que um telefone pede, mesmo a
  // 390px DPR3 ≈ 1170px) aponta para w780/w1280, jamais original.
  for (const e of entries) {
    if (e.width <= 1280) assert.doesNotMatch(e.url, /\/original\//);
  }
  // original existe apenas no topo (3840w), para telas grandes/4K/Retina.
  const original = entries.find((e) => /\/original\//.test(e.url));
  assert.ok(original && original.width === 3840);
});

test("heroBackdropSrc cai em w1280 como fallback seguro; URL completa passa direto", () => {
  assert.equal(heroBackdropSrc("/abc.jpg"), `${BASE}/w1280/abc.jpg`);
  const url = "https://cdn.exemplo.com/ja-pronto.jpg";
  assert.equal(heroBackdropSrc(url), url);
  // URL completa não tem variantes de token → sem srcSet.
  assert.equal(heroBackdropSrcSet(url), undefined);
});

test("MediaHero usa <img> responsivo e não serve mais o backdrop em 'original'", () => {
  const hero = ler("src/components/ui/MediaHero.tsx");
  assert.match(hero, /srcSet=\{heroBackdropSrcSet\(backdrop\)\}/);
  assert.match(hero, /src=\{heroBackdropSrc\(backdrop\)\}/);
  assert.match(hero, /sizes="100vw"/);
  assert.match(hero, /fetchPriority="high"/);
  // A regressão que 1B corrige: backdrop cru em "original" para todo viewport.
  assert.doesNotMatch(hero, /imgUrl\(backdrop, "original"\)/);
  // E não voltou a depender do next/image para o backdrop (a flag global o
  // tornaria src cru sem srcset).
  assert.doesNotMatch(hero, /loader=\{tmdbBackdropLoader\}/);
});
