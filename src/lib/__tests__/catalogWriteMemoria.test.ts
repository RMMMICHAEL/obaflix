import assert from "node:assert/strict";
import test from "node:test";
import { upsertCatalogEpisodesBulk, upsertCatalogMovie, upsertCatalogSeries } from "../catalog-write";

// Banco em memória: prova idempotência e preservação de campos com a mesma
// semântica de upsert do Prisma (update mescla, create só na primeira vez).
function memoryDb() {
  const filmes = new Map<string, any>();
  const series = new Map<string, any>();
  const eps = new Map<string, any>();
  const filmeGeneros: Array<{ filmeId: string; generoId: number }> = [];
  const key = (k: any) => `${k.serieId}|${k.temporada}|${k.numeroEp}`;
  const table = (rows: Map<string, any>, keyOf: (where: any) => string) => ({
    findUnique: async ({ where }: any) => rows.get(keyOf(where)) ?? null,
    upsert: async ({ where, update, create }: any) => {
      const k = keyOf(where);
      const row = rows.has(k) ? { ...rows.get(k), ...update } : { ...create };
      rows.set(k, row);
      return row;
    },
  });
  const db: any = {
    filme: table(filmes, (w) => w.id),
    serie: table(series, (w) => w.id),
    episodio: table(eps, (w) => key(w.serieId_temporada_numeroEp)),
    genero: { upsert: async () => ({}) },
    filmeGenero: {
      deleteMany: async ({ where }: any) => {
        for (let i = filmeGeneros.length - 1; i >= 0; i--) if (filmeGeneros[i].filmeId === where.filmeId) filmeGeneros.splice(i, 1);
      },
      create: async ({ data }: any) => { filmeGeneros.push(data); },
    },
    $transaction: async (fn: any) => fn(db),
  };
  return { db, filmes, series, eps, filmeGeneros };
}

test("upsert de filme repetido é idempotente e campo ausente/vazio da origem não apaga", async () => {
  const { db, filmes, filmeGeneros } = memoryDb();
  const full = { id: "f1", titulo: "Filme", poster: "/p.jpg", sinopse: "boa", ano: 2020, nota: 7.5, urlDub: "u-dub", generos: [{ id: 1, nome: "Ação" }] };
  assert.equal((await upsertCatalogMovie(full, db)).created, true);
  assert.equal((await upsertCatalogMovie(full, db)).created, false);
  assert.equal(filmes.size, 1);
  await upsertCatalogMovie({ id: "f1", titulo: "Filme", poster: "", sinopse: "  ", ano: "", nota: "abc", generos: [] }, db);
  const row = filmes.get("f1");
  assert.equal(row.poster, "/p.jpg");
  assert.equal(row.sinopse, "boa");
  assert.equal(row.ano, 2020);
  assert.equal(row.nota, 7.5);
  assert.equal(row.urlDub, "u-dub");
  assert.deepEqual(filmeGeneros, [{ filmeId: "f1", generoId: 1 }], "lista vazia de gêneros não apaga");
});

test("null limpa explicitamente; editor humano limpa texto com string vazia, mas nunca número", async () => {
  const { db, filmes } = memoryDb();
  await upsertCatalogMovie({ id: "f1", titulo: "Filme", urlDub: "a", urlLeg: "b", ano: 2020 }, db);
  await upsertCatalogMovie({ id: "f1", titulo: "Filme", urlLeg: null }, db);
  assert.equal(filmes.get("f1").urlLeg, null);
  await upsertCatalogMovie({ id: "f1", titulo: "Filme", urlDub: "", ano: "" }, db, { emptyStringClears: true });
  assert.equal(filmes.get("f1").urlDub, null);
  assert.equal(filmes.get("f1").ano, 2020);
});

test("inteiros são truncados e série sem tipo nasce 'serie' sem sobrescrever tipo existente", async () => {
  const { db, filmes, series } = memoryDb();
  await upsertCatalogMovie({ id: "f1", titulo: "Filme", ano: "2021.9", duracao: 95.4, nota: "8.25" }, db);
  assert.equal(filmes.get("f1").ano, 2021);
  assert.equal(filmes.get("f1").duracao, 95);
  assert.equal(filmes.get("f1").nota, 8.25);
  await upsertCatalogSeries({ id: "s1", titulo: "Anime", tipo: "anime" }, db);
  await upsertCatalogSeries({ id: "s1", titulo: "Anime", tipo: "" }, db);
  await upsertCatalogSeries({ id: "s1", titulo: "Anime" }, db);
  assert.equal(series.get("s1").tipo, "anime");
  await upsertCatalogSeries({ id: "s2", titulo: "Nova" }, db);
  assert.equal(series.get("s2").tipo, "serie");
});

test("episódios bulk repetidos não duplicam, aceitam aliases legados e temporada padrão 1", async () => {
  const { db, eps } = memoryDb();
  const lote = [
    { ep: "1", temp: "1", nome: "Um", urlBR: "dub-1" },
    { numeroEp: 2, urlDub: "", urlENG: "leg-2" },
    { ep: "x" },
  ];
  const r1 = await upsertCatalogEpisodesBulk("s1", lote, db);
  assert.deepEqual([r1.added, r1.updated, r1.errors.length], [2, 0, 1]);
  const r2 = await upsertCatalogEpisodesBulk("s1", lote, db);
  assert.deepEqual([r2.added, r2.updated], [0, 2]);
  assert.equal(eps.size, 2);
  assert.equal(eps.get("s1|1|1").titulo, "Um");
  assert.equal(eps.get("s1|1|1").urlDub, "dub-1");
  assert.equal(eps.get("s1|1|2").urlLeg, "leg-2");
  await upsertCatalogEpisodesBulk("s1", [{ ep: 1, temp: 1 }], db);
  assert.equal(eps.get("s1|1|1").urlDub, "dub-1", "episódio sem URL na origem mantém a existente");
});
