import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { backdropToken, tmdbBackdropLoader } from "../tmdb-image";

/**
 * Fase Velocidade 1B — backdrop responsivo do hero.
 * Com images.unoptimized ligado, o next/image não gera srcset sozinho; o loader
 * devolve essa responsividade mapeando a largura pedida para o token do TMDB.
 */

const ler = (p: string) => readFileSync(p, "utf8");

test("backdropToken escolhe o menor token que cobre a largura", () => {
  assert.equal(backdropToken(300), "w300");
  assert.equal(backdropToken(640), "w780");
  assert.equal(backdropToken(780), "w780");
  assert.equal(backdropToken(1080), "w1280");
  assert.equal(backdropToken(1280), "w1280");
});

test("telas grandes / 4K / Retina preservam a arte cheia (original)", () => {
  assert.equal(backdropToken(1281), "original");
  assert.equal(backdropToken(1920), "original");
  assert.equal(backdropToken(3840), "original");
});

test("tmdbBackdropLoader monta a URL do TMDB no token da largura", () => {
  assert.equal(
    tmdbBackdropLoader({ src: "/abc.jpg", width: 640, quality: 75 }),
    "https://image.tmdb.org/t/p/w780/abc.jpg",
  );
  assert.equal(
    tmdbBackdropLoader({ src: "/abc.jpg", width: 3840, quality: 75 }),
    "https://image.tmdb.org/t/p/original/abc.jpg",
  );
  // Caminho sem barra inicial ainda resolve.
  assert.equal(
    tmdbBackdropLoader({ src: "abc.jpg", width: 1280, quality: 75 }),
    "https://image.tmdb.org/t/p/w1280/abc.jpg",
  );
});

test("URL completa passa direto pelo loader (já é final)", () => {
  const url = "https://cdn.exemplo.com/ja-pronto.jpg";
  assert.equal(tmdbBackdropLoader({ src: url, width: 1920, quality: 75 }), url);
});

test("MediaHero usa o loader responsivo e não serve mais o backdrop em 'original'", () => {
  const hero = ler("src/components/ui/MediaHero.tsx");
  assert.match(hero, /loader=\{tmdbBackdropLoader\}/);
  assert.match(hero, /unoptimized=\{false\}/);
  // A regressão que 1B corrige: backdrop cru em "original" para todo viewport.
  assert.doesNotMatch(hero, /imgUrl\(backdrop, "original"\)/);
});
