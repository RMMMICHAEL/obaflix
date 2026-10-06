import { test } from "node:test";
import assert from "node:assert/strict";

import { slugifySeo, catalogPath, catalogSlugId, genrePath, parseSeoParam } from "@/lib/catalog-url";

test("slugifySeo: lowercase, sem acentos, pontuação e espaços viram hífen", () => {
  assert.equal(slugifySeo("O Mentalista"), "o-mentalista");
  assert.equal(slugifySeo("Ficção Científica"), "ficcao-cientifica");
  assert.equal(slugifySeo("  Olá,  Mundo!  "), "ola-mundo");
  assert.equal(slugifySeo("Spider-Man: No Way Home"), "spider-man-no-way-home");
  assert.equal(slugifySeo("Coração Valente"), "coracao-valente");
});

test("slugifySeo: hifens repetidos colapsam, bordas sem hífen, fallback seguro", () => {
  assert.equal(slugifySeo("---a---b---"), "a-b");
  assert.equal(slugifySeo("9-1-1"), "9-1-1");
  assert.equal(slugifySeo(""), "titulo");
  assert.equal(slugifySeo("!!!"), "titulo");
  assert.equal(slugifySeo(null), "titulo");
  assert.equal(slugifySeo(undefined), "titulo");
});

test("catalogPath: filme/serie e anime/desenho em /serie", () => {
  assert.equal(catalogPath("filme", "xyz456", "Nando"), "/filme/nando--xyz456");
  assert.equal(catalogPath("serie", "abc123", "O Mentalista"), "/serie/o-mentalista--abc123");
  assert.equal(catalogPath("anime", "a1", "Naruto"), "/serie/naruto--a1");
  assert.equal(catalogPath("desenho", "d1", "Bob Esponja"), "/serie/bob-esponja--d1");
});

test("genrePath: slug do nome + id numérico", () => {
  assert.equal(genrePath(80, "Crime"), "/genero/crime--80");
  assert.equal(genrePath(18, "Drama"), "/genero/drama--18");
  assert.equal(genrePath(9648, "Mistério"), "/genero/misterio--9648");
});

test("parseSeoParam: extrai o id depois do último '--'; sem separador é id legado", () => {
  assert.equal(parseSeoParam("o-mentalista--abc123"), "abc123");
  assert.equal(parseSeoParam("nando--xyz456"), "xyz456");
  assert.equal(parseSeoParam("crime--80"), "80");
  assert.equal(parseSeoParam("9-1-1--abc"), "abc");
  assert.equal(parseSeoParam("abc123"), "abc123");
  assert.equal(parseSeoParam("80"), "80");
});

test("round-trip: catalogSlugId → parseSeoParam devolve o id", () => {
  const id = "ck1a2b3c";
  assert.equal(catalogSlugId("O Mentalista", id), "o-mentalista--ck1a2b3c");
  assert.equal(parseSeoParam(catalogSlugId("O Mentalista", id)), id);
});
