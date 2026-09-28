import assert from "node:assert/strict";
import test from "node:test";

import { mergeProviderUrl, normalizeTmdbId } from "../catalog-ingest";

test("normalizeTmdbId rejeita identidade ausente e o sentinela zero", () => {
  assert.equal(normalizeTmdbId(null), null);
  assert.equal(normalizeTmdbId("  "), null);
  assert.equal(normalizeTmdbId(0), null);
  assert.equal(normalizeTmdbId("0"), null);
  assert.equal(normalizeTmdbId(" 123 "), "123");
});

test("mergeProviderUrl preserva espelhos e não repete a URL recebida", () => {
  const webcine = "https://webcinevs2.com/watch?id=123&type=movie";
  assert.equal(mergeProviderUrl(null, webcine), webcine);
  assert.equal(
    mergeProviderUrl("https://origem.example/filme, https://espelho.example/filme", webcine),
    `https://origem.example/filme,https://espelho.example/filme,${webcine}`,
  );
  assert.equal(mergeProviderUrl(webcine, webcine), webcine);
});
