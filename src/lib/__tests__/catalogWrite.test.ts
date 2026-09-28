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

test("episode write looks up by coordinate (never by external id), deterministically, without native upsert", async () => {
  const finds: any[] = [];
  const creates: any[] = [];
  const updates: any[] = [];
  let exists = false;
  const db: any = { episodio: {
    findFirst: async (args: any) => { finds.push(args); return exists ? { id: "canonical" } : null; },
    create: async (args: any) => { creates.push(args); exists = true; return { id: args.data.id }; },
    update: async (args: any) => { updates.push(args); return { id: args.where.id }; },
    upsert: async () => { throw new Error("upsert na chave composta exige o índice único no banco"); },
  } };
  const input = { serieId: "s1", temporada: 2, numeroEp: 7, titulo: "Sete" };
  assert.deepEqual(await upsertCatalogEpisode(input, db), { id: "s1-t2e7", created: true });
  // Segunda fonte, outro ID externo, mesma coordenada: UPDATE da linha existente.
  assert.deepEqual(await upsertCatalogEpisode({ ...input, id: "wc_ep_560647", urlDub: "u" }, db), { id: "canonical", created: false });
  assert.deepEqual(finds[0].where, { serieId: "s1", temporada: 2, numeroEp: 7 });
  assert.deepEqual(finds[0].orderBy, [{ createdAt: "asc" }, { id: "asc" }]);
  assert.equal(creates.length, 1);
  assert.deepEqual(updates[0], { where: { id: "canonical" }, data: { titulo: "Sete", urlDub: "u" } });
});

test("episode create race after the unique index (P2002) becomes an update of the winner", async () => {
  let calls = 0;
  const updates: any[] = [];
  const db: any = { episodio: {
    findFirst: async () => (calls++ === 0 ? null : { id: "winner" }),
    create: async () => { throw Object.assign(new Error("unique"), { code: "P2002" }); },
    update: async (args: any) => { updates.push(args); return {}; },
  } };
  assert.deepEqual(await upsertCatalogEpisode({ serieId: "s1", temporada: 1, numeroEp: 1, urlDub: "x" }, db), { id: "winner", created: false });
  assert.deepEqual(updates, [{ where: { id: "winner" }, data: { urlDub: "x" } }]);
});
