import assert from "node:assert/strict";
import test from "node:test";
import { upsertCatalogEpisode, upsertCatalogMovie } from "../catalog-write";

test("movie upsert does not erase good fields omitted by the source", async () => {
  let args: any;
  const db: any = {
    filme: { findUnique: async () => ({ id: "10" }), upsert: async (value: any) => { args = value; return { id: "10" }; } },
    $transaction: async (fn: any) => fn(db), filmeGenero: {}, genero: {},
  };
  const result = await upsertCatalogMovie({ id: "10", titulo: "Filme atualizado", nota: 8 }, db);
  assert.equal(result.created, false);
  assert.deepEqual(args.update, { titulo: "Filme atualizado", nota: 8 });
  assert.equal("poster" in args.update, false);
  assert.equal("urlDub" in args.update, false);
});

test("episode upsert always uses the compound identity and stays idempotent", async () => {
  const calls: any[] = [];
  let exists = false;
  const db: any = { episodio: {
    findUnique: async () => exists ? ({ id: "canonical" }) : null,
    upsert: async (args: any) => { calls.push(args); exists = true; return { id: "canonical" }; },
  } };
  const input = { serieId: "s1", temporada: 2, numeroEp: 7, titulo: "Sete" };
  assert.equal((await upsertCatalogEpisode(input, db)).created, true);
  assert.equal((await upsertCatalogEpisode(input, db)).created, false);
  assert.deepEqual(calls[0].where, { serieId_temporada_numeroEp: { serieId: "s1", temporada: 2, numeroEp: 7 } });
  assert.equal(calls[0].create.id, "s1-t2e7");
});
