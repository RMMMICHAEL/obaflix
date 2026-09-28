import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { episodiosGravados, pruneCatalogPayload, resolveCatalogDestino } from "../catalog-destino";
import { upsertCatalogEpisodesBulk, upsertCatalogMovie, upsertCatalogSeries } from "../catalog-write";

const ADMIN = "a".repeat(48);
const CATALOG = "c".repeat(48);

test("padrão continua legado: /api/admin com x-admin-token, corpo intacto", () => {
  const d = resolveCatalogDestino({ ADMIN_SECRET_TOKEN: ADMIN });
  assert.equal(d.modo, "legado");
  assert.equal(d.baseUrl, "https://obaflix.vercel.app");
  assert.equal(d.paths.filme, "/api/admin/filme");
  assert.equal(d.headers["x-admin-token"], ADMIN);
  assert.equal(d.paths.consulta, null);
  const body = { id: "1", titulo: "X", sinopse: null };
  assert.equal(d.body("filme", body), body);
});

test("modo integração: rotas de catálogo, Bearer CATALOG_SYNC_TOKEN e nenhum token admin", () => {
  const d = resolveCatalogDestino({ OBAFLIX_SYNC_DESTINO: "integracao", CATALOG_SYNC_TOKEN: CATALOG, ADMIN_SECRET_TOKEN: ADMIN, OBAFLIX_URL: "https://x.test/" });
  assert.equal(d.modo, "integracao");
  assert.equal(d.baseUrl, "https://x.test");
  assert.deepEqual(d.paths, {
    filme: "/api/integracoes/catalogo/filme",
    serie: "/api/integracoes/catalogo/serie",
    episodiosBulk: "/api/integracoes/catalogo/episodios/bulk",
    consulta: "/api/integracoes/catalogo/consulta",
  });
  assert.equal(d.headers.Authorization, `Bearer ${CATALOG}`);
  assert.ok(!JSON.stringify(d.headers).includes(ADMIN));
});

test("integração exige token forte; modo desconhecido é erro (sem fallback silencioso)", () => {
  assert.throws(() => resolveCatalogDestino({ OBAFLIX_SYNC_DESTINO: "integracao" }), /CATALOG_SYNC_TOKEN/);
  assert.throws(() => resolveCatalogDestino({ OBAFLIX_SYNC_DESTINO: "integracao", CATALOG_SYNC_TOKEN: "curto" }), /mínimo 32/);
  assert.throws(() => resolveCatalogDestino({ OBAFLIX_SYNC_DESTINO: "novo" }), /inválido/);
  assert.throws(() => resolveCatalogDestino({}), /ADMIN_SECRET_TOKEN é obrigatório/);
});

test("poda do corpo: null/vazio/NaN saem, tipo 'serie' padrão sai, outros tipos ficam", () => {
  assert.deepEqual(pruneCatalogPayload("filme", { id: "1", titulo: "X", sinopse: null, poster: "", ano: NaN, nota: 0, urlDub: "u" }), { id: "1", titulo: "X", nota: 0, urlDub: "u" });
  assert.deepEqual(pruneCatalogPayload("serie", { id: "s", titulo: "S", tipo: "serie" }), { id: "s", titulo: "S" });
  assert.deepEqual(pruneCatalogPayload("serie", { id: "s", titulo: "S", tipo: "anime" }), { id: "s", titulo: "S", tipo: "anime" });
  assert.deepEqual(pruneCatalogPayload("episodios", { serieId: "s", episodios: [{ ep: 1, temp: 1, urlDub: "d", urlLeg: null }] }), { serieId: "s", episodios: [{ ep: 1, temp: 1, urlDub: "d" }] });
});

test("contagem de episódios gravados nos dois formatos de resposta", () => {
  assert.equal(episodiosGravados({ ok: 3, errors: 0 }), 3);
  assert.equal(episodiosGravados({ ok: true, added: 2, updated: 5, errors: [] }), 7);
  assert.equal(episodiosGravados(null), 0);
});

// ── Idempotência e "sem perder conteúdo" com o corpo real dos produtores ─────

function memoryDb() {
  const rows = { filme: new Map<string, any>(), serie: new Map<string, any>(), ep: new Map<string, any>() };
  const table = (m: Map<string, any>, keyOf: (w: any) => string) => ({
    findUnique: async ({ where }: any) => m.get(keyOf(where)) ?? null,
    upsert: async ({ where, update, create }: any) => { const k = keyOf(where); const row = m.has(k) ? { ...m.get(k), ...update } : { ...create }; m.set(k, row); return row; },
  });
  const db: any = {
    filme: table(rows.filme, (w) => w.id),
    serie: table(rows.serie, (w) => w.id),
    episodio: table(rows.ep, (w) => `${w.serieId_temporada_numeroEp.serieId}|${w.serieId_temporada_numeroEp.temporada}|${w.serieId_temporada_numeroEp.numeroEp}`),
    $transaction: async (fn: any) => fn(db), genero: { upsert: async () => ({}) }, filmeGenero: { deleteMany: async () => ({}), create: async () => ({}) }, serieGenero: { deleteMany: async () => ({}), create: async () => ({}) },
  };
  return { db, rows };
}

test("produtor em modo integração repetindo o mesmo envio é idempotente e não apaga o que a origem omitiu", async () => {
  const { db, rows } = memoryDb();
  const d = resolveCatalogDestino({ OBAFLIX_SYNC_DESTINO: "integracao", CATALOG_SYNC_TOKEN: CATALOG });
  await upsertCatalogMovie(d.body("filme", { id: "10", titulo: "Filme", sinopse: "boa", ano: 2020, urlDub: "dub" }), db);
  // Mesmo título visto de novo pelo painel MegaFlix, agora sem sinopse/ano/url (o userscript manda null).
  const tampermonkeyBody = { id: "10", tmdbId: null, titulo: "Filme", tituloOriginal: null, poster: null, sinopse: null, ano: null, nota: null, urlDub: null, urlLeg: null };
  await upsertCatalogMovie(d.body("filme", tampermonkeyBody), db);
  await upsertCatalogMovie(d.body("filme", tampermonkeyBody), db);
  assert.equal(rows.filme.size, 1);
  assert.deepEqual([rows.filme.get("10").sinopse, rows.filme.get("10").ano, rows.filme.get("10").urlDub], ["boa", 2020, "dub"]);

  await upsertCatalogSeries({ id: "s1", titulo: "Anime", tipo: "anime" }, db);
  await upsertCatalogSeries(d.body("serie", { id: "s1", titulo: "Anime", tipo: "serie", ano: null }), db);
  assert.equal(rows.serie.get("s1").tipo, "anime", "não rebaixa anime para série");

  const lote = d.body("episodios", { serieId: "s1", episodios: [{ ep: 1, temp: 1, urlDub: "d1", urlLeg: null }, { ep: 2, temp: 1, urlDub: "d2" }] }) as any;
  await upsertCatalogEpisodesBulk(lote.serieId, lote.episodios, db);
  const again = await upsertCatalogEpisodesBulk(lote.serieId, lote.episodios, db);
  assert.deepEqual([again.added, again.updated, rows.ep.size], [0, 2, 2]);
});

test("sem a poda, o null do produtor apagaria o campo — por isso o modo integração poda", async () => {
  const { db, rows } = memoryDb();
  await upsertCatalogMovie({ id: "10", titulo: "Filme", sinopse: "boa" }, db);
  await upsertCatalogMovie({ id: "10", titulo: "Filme", sinopse: null }, db);
  assert.equal(rows.filme.get("10").sinopse, null);
});

test("Tampermonkey tem os dois modos, legado padrão e mesma regra de poda", () => {
  const src = readFileSync("scripts/tampermonkey-sync.js", "utf8");
  assert.match(src, /setting\('obaflixModo', 'legado'\) === 'integracao' \? 'integracao' : 'legado'/);
  assert.match(src, /'\/api\/integracoes\/catalogo\/episodios\/bulk'/);
  assert.match(src, /Authorization: 'Bearer ' \+ TOKEN/);
  assert.match(src, /kind === 'serie' && key === 'tipo' && value === 'serie'/);
  assert.doesNotMatch(src, /GM_getValue\('obaflix(Admin|Catalog)Token', '[^']+'\)/, "sem token embutido");
});
