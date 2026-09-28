import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, type NextFetchEvent } from "next/server";
import { decideSurfaceGate, publicCutoverEnabled } from "../../config/obaflix-surface";
import { requireAdmin, requireAdminOrLegacyCatalogToken } from "../auth";
import { requireCatalogSync } from "../catalogSyncAuth";
import { CATALOG_WRITE_MAQUINA, upsertCatalogEpisodesBulk, upsertCatalogMovie, upsertCatalogSeries } from "../catalog-write";
import { memoryEpisodeTable } from "./memoryEpisodes";

const ADMIN = "a".repeat(48);
const CATALOG = "c".repeat(48);

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

let ip = 0;
const req = (path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown) =>
  new NextRequest(`https://obaflix.test${path}`, {
    method,
    headers: { "x-forwarded-for": `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const PUBLIC_OFF = { OBAFLIX_SURFACE: "public", PUBLIC_CUTOVER_ATIVO: "0", OBAFLIX_PUBLIC_ADMIN_CUTOVER: undefined, ADMIN_SECRET_TOKEN: ADMIN, CATALOG_SYNC_TOKEN: CATALOG };

// ── Sessão admin: única credencial humana ────────────────────────────────────

test("requireAdmin: sessão admin passa; role user, JWT admin com DB user e sem sessão são negados", async () => {
  const jwtAdmin = async () => ({ user: { id: "u1", role: "admin" } });
  assert.equal(await requireAdmin(req("/api/admin/usuarios"), { loadSession: jwtAdmin, roleOf: async () => "admin" }), null);
  assert.equal((await requireAdmin(req("/api/admin/usuarios"), { loadSession: async () => ({ user: { id: "u2", role: "user" } }), roleOf: async () => "user" }))?.status, 403);
  assert.equal((await requireAdmin(req("/api/admin/usuarios"), { loadSession: jwtAdmin, roleOf: async () => "user" }))?.status, 403, "JWT diz admin, banco diz user");
  assert.equal((await requireAdmin(req("/api/admin/usuarios"), { loadSession: jwtAdmin, roleOf: async () => null }))?.status, 403, "usuário apagado");
  assert.equal((await requireAdmin(req("/api/admin/usuarios"), { loadSession: async () => null }))?.status, 401);
});

test("requireAdmin: x-admin-token válido é recusado em API humana, em qualquer superfície e com cutover desligado", async () => {
  for (const surface of ["public", "admin"]) {
    await withEnv({ ...PUBLIC_OFF, OBAFLIX_SURFACE: surface }, async () => {
      const r = await requireAdmin(req("/api/admin/usuarios", { "x-admin-token": ADMIN }), {
        loadSession: async () => { throw new Error("não deveria consultar sessão"); },
      });
      assert.equal(r?.status, 403, surface);
    });
  }
});

test("rotas humanas reais recusam o token legado antes de tocar em banco, TMDB ou provedor", async () => {
  await withEnv(PUBLIC_OFF, async () => {
    const rotas: Array<[string, string, any]> = [
      ["/api/admin/usuarios", "GET", await import("../../app/api/admin/usuarios/route")],
      ["/api/admin/usuarios/u1", "GET", await import("../../app/api/admin/usuarios/[id]/route")],
      ["/api/admin/reset-password", "POST", await import("../../app/api/admin/reset-password/route")],
      ["/api/admin/assinaturas", "GET", await import("../../app/api/admin/assinaturas/route")],
      ["/api/admin/assinaturas/acao", "POST", await import("../../app/api/admin/assinaturas/acao/route")],
      ["/api/admin/pagamentos", "GET", await import("../../app/api/admin/pagamentos/route")],
      ["/api/admin/pagamentos/revisoes", "GET", await import("../../app/api/admin/pagamentos/revisoes/route")],
      ["/api/admin/canais", "GET", await import("../../app/api/admin/canais/route")],
      ["/api/admin/canais", "POST", await import("../../app/api/admin/canais/route")],
      ["/api/admin/auditoria", "GET", await import("../../app/api/admin/auditoria/route")],
      ["/api/admin/sincronizacoes", "GET", await import("../../app/api/admin/sincronizacoes/route")],
      ["/api/admin/stats", "GET", await import("../../app/api/admin/stats/route")],
      ["/api/admin/import", "POST", await import("../../app/api/admin/import/route")],
      ["/api/admin/sync-top250", "POST", await import("../../app/api/admin/sync-top250/route")],
      ["/api/admin/backfill-logos", "POST", await import("../../app/api/admin/backfill-logos/route")],
      ["/api/admin/tmdb-search", "GET", await import("../../app/api/admin/tmdb-search/route")],
      ["/api/admin/security-metrics", "GET", await import("../../app/api/admin/security-metrics/route")],
      ["/api/admin/episodio", "GET", await import("../../app/api/admin/episodio/route")],
      ["/api/admin/episodio", "POST", await import("../../app/api/admin/episodio/route")],
      ["/api/admin/episodio", "DELETE", await import("../../app/api/admin/episodio/route")],
      ["/api/admin/filme", "DELETE", await import("../../app/api/admin/filme/route")],
      ["/api/admin/serie", "DELETE", await import("../../app/api/admin/serie/route")],
      ["/api/player/debug-segment", "GET", await import("../../app/api/player/debug-segment/route")],
    ];
    const revisaoAcao = await import("../../app/api/admin/pagamentos/revisoes/[id]/route");
    for (const [path, method, mod] of rotas) {
      const r = await mod[method](req(path, { "x-admin-token": ADMIN }, method, method === "GET" ? undefined : { id: "x" }), { params: { id: "x" } });
      assert.equal(r.status, 403, `${method} ${path}`);
    }
    const r = await revisaoAcao.POST(req("/api/admin/pagamentos/revisoes/r1", { "x-admin-token": ADMIN }, "POST", { acao: "ativar" }), { params: { id: "r1" } });
    assert.equal(r.status, 403, "ação financeira com token legado");
  });
});

// ── Transição do catálogo legado ────────────────────────────────────────────

test("catálogo legado: token aceito só em GET/POST, superfície pública, cutover desligado e token forte", async () => {
  const session = { loadSession: async () => null };
  await withEnv(PUBLIC_OFF, async () => {
    assert.equal(await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", { "x-admin-token": ADMIN }, "POST"), session), null);
    assert.equal(await requireAdminOrLegacyCatalogToken(req("/api/admin/serie", { "x-admin-token": ADMIN }, "GET"), session), null);
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/serie", { "x-admin-token": ADMIN }, method), session))?.status, 403, method);
    }
    assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", { "x-admin-token": "b".repeat(48) }, "POST"), session))?.status, 403, "token errado");
    assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", { "x-admin-token": ADMIN.slice(1) }, "POST"), session))?.status, 403, "tamanho diferente");
    assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", { authorization: `Bearer ${CATALOG}` }, "POST"), session))?.status, 401, "token de catálogo não abre /api/admin");
    assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", {}, "POST"), session))?.status, 401);
  });
  await withEnv({ ...PUBLIC_OFF, ADMIN_SECRET_TOKEN: "curto" }, async () => {
    assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", { "x-admin-token": "curto" }, "POST"), session))?.status, 403, "segredo fraco nunca autoriza");
  });
  await withEnv({ ...PUBLIC_OFF, ADMIN_SECRET_TOKEN: undefined }, async () => {
    assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", { "x-admin-token": ADMIN }, "POST"), session))?.status, 403, "sem ADMIN_SECRET_TOKEN no deploy o legado está desligado");
  });
  await withEnv({ ...PUBLIC_OFF, PUBLIC_CUTOVER_ATIVO: "1" }, async () => {
    assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", { "x-admin-token": ADMIN }, "POST"), session))?.status, 403, "cutover ligado");
  });
  await withEnv({ ...PUBLIC_OFF, OBAFLIX_SURFACE: "admin" }, async () => {
    assert.equal((await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", { "x-admin-token": ADMIN }, "POST"), session))?.status, 403, "painel separado nunca");
    // Sessão admin continua valendo nas mesmas rotas.
    assert.equal(await requireAdminOrLegacyCatalogToken(req("/api/admin/filme", {}, "POST"), { loadSession: async () => ({ user: { id: "a" } }), roleOf: async () => "admin" }), null);
  });
});

test("CORS do legado: só para admin.megafrixapi.com, só GET/POST, e nunca no painel ou após o cutover", async () => {
  const origin = { origin: "https://admin.megafrixapi.com" };
  await withEnv(PUBLIC_OFF, async () => {
    const r = await requireAdminOrLegacyCatalogToken(req("/api/admin/serie", origin, "OPTIONS"));
    assert.equal(r?.status, 204);
    assert.equal(r?.headers.get("access-control-allow-origin"), "https://admin.megafrixapi.com");
    assert.equal(r?.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    const other = await requireAdminOrLegacyCatalogToken(req("/api/admin/serie", { origin: "https://evil.test" }, "OPTIONS"));
    assert.equal(other?.headers.get("access-control-allow-origin"), null);
  });
  for (const env of [{ ...PUBLIC_OFF, PUBLIC_CUTOVER_ATIVO: "1" }, { ...PUBLIC_OFF, OBAFLIX_SURFACE: "admin" }]) {
    await withEnv(env, async () => {
      const r = await requireAdminOrLegacyCatalogToken(req("/api/admin/serie", origin, "OPTIONS"));
      assert.equal(r?.headers.get("access-control-allow-origin"), null);
    });
  }
});

test("rotas de catálogo legado: só filme/serie/episodio-bulk conhecem o token legado; nenhuma rota humana", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? files(f) : [f];
  });
  const permitidas = new Set(["src/app/api/admin/filme/route.ts", "src/app/api/admin/serie/route.ts", "src/app/api/admin/episodio/bulk/route.ts"].map((p) => join(p)));
  for (const f of files("src/app/api/admin")) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /x-admin-token|ADMIN_SECRET_TOKEN/, f);
    if (!permitidas.has(f)) assert.doesNotMatch(src, /requireAdminOrLegacyCatalogToken/, f);
    assert.match(src, /requireAdmin\(|requireAdminSession\(|requireAdminAction\(|requireAdminOrLegacyCatalogToken\(|autorizar\(req\)/, `${f} sem guarda`);
  }
  // DELETE nunca aceita o legado, mesmo nas rotas de catálogo.
  for (const f of permitidas) {
    const del = readFileSync(f, "utf8").split("export async function DELETE")[1];
    if (del) assert.match(del.slice(0, 120), /requireAdmin\(req\)/, f);
  }
});

// ── Cutover ─────────────────────────────────────────────────────────────────

test("PUBLIC_CUTOVER_ATIVO: padrão desligado; nome da fase 1 continua aceito; 0 desliga", async () => {
  assert.equal(publicCutoverEnabled(undefined), false);
  assert.equal(publicCutoverEnabled(""), false);
  assert.equal(publicCutoverEnabled("0"), false);
  assert.equal(publicCutoverEnabled("false"), false);
  assert.equal(publicCutoverEnabled("sim"), false);
  assert.equal(publicCutoverEnabled("1"), true);
  assert.equal(publicCutoverEnabled(" TRUE "), true);
  await withEnv({ PUBLIC_CUTOVER_ATIVO: undefined, OBAFLIX_PUBLIC_ADMIN_CUTOVER: undefined }, () => assert.equal(publicCutoverEnabled(), false));
  await withEnv({ PUBLIC_CUTOVER_ATIVO: undefined, OBAFLIX_PUBLIC_ADMIN_CUTOVER: "true" }, () => assert.equal(publicCutoverEnabled(), true));
  await withEnv({ PUBLIC_CUTOVER_ATIVO: "0", OBAFLIX_PUBLIC_ADMIN_CUTOVER: "true" }, () => assert.equal(publicCutoverEnabled(), false, "nome oficial vence"));
});

const event = {} as NextFetchEvent;
async function runMiddleware(path: string, env: Record<string, string | undefined>) {
  return withEnv(env, async () => {
    const { default: middleware } = await import("../../middleware");
    return middleware(req(path), event) as Response;
  });
}

test("middleware real, público com cutover OFF: /admin e /api/admin seguem o fluxo atual", async () => {
  const api = await runMiddleware("/api/admin/usuarios", PUBLIC_OFF);
  assert.equal(api.headers.get("x-middleware-next"), "1", "API segue para o handler (que exige sessão)");
  const page = await runMiddleware("/admin", PUBLIC_OFF);
  assert.notEqual(page.status, 404);
  const home = await runMiddleware("/", PUBLIC_OFF);
  assert.notEqual(home.status, 404);
});

test("middleware real, público com cutover ON: /admin, /admin/* e /api/admin/* = 404; resto intacto", async () => {
  const on = { ...PUBLIC_OFF, PUBLIC_CUTOVER_ATIVO: "1" };
  for (const p of ["/admin", "/admin/usuarios", "/api/admin/usuarios", "/api/admin/filme", "/api/admin/pagamentos/revisoes"]) {
    assert.equal((await runMiddleware(p, on)).status, 404, p);
  }
  assert.equal((await (await runMiddleware("/api/admin/filme", on)).json()).error, "Não encontrado");
  for (const p of ["/", "/filmes", "/login"]) assert.notEqual((await runMiddleware(p, on)).status, 404, p);
});

test("middleware real, superfície ADMIN: / → /admin; /api/admin segue; streaming e cadastro 404, com ou sem cutover", async () => {
  for (const cutover of ["0", "1"]) {
    const env = { ...PUBLIC_OFF, OBAFLIX_SURFACE: "admin", PUBLIC_CUTOVER_ATIVO: cutover };
    const root = await runMiddleware("/", env);
    assert.equal(root.status, 307);
    assert.equal(new URL(root.headers.get("location")!).pathname, "/admin");
    assert.equal((await runMiddleware("/api/admin/usuarios", env)).headers.get("x-middleware-next"), "1");
    for (const p of ["/filmes", "/filme/1", "/assistir/1", "/cadastro", "/conta", "/planos"]) {
      assert.equal((await runMiddleware(p, env)).status, 404, p);
    }
  }
});

test("superfície ADMIN no build: APIs fora de admin/auth/integracoes, cadastro e sitemap vão para destino inexistente", () => {
  const cfg = readFileSync("next.config.mjs", "utf8");
  assert.match(cfg, /source: "\/api\/:rota\(\(\?!admin\/\|admin\$\|auth\/\|auth\$\|integracoes\/\|integracoes\$\)\.\*\)"/);
  assert.match(cfg, /source: "\/api\/auth\/cadastro"/);
  assert.match(cfg, /source: "\/sitemap\.xml"/);
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(layout, /noindex|index: false/);
});

test("integrações nunca dependem de /api/admin nem do cutover", () => {
  assert.equal(decideSurfaceGate("/api/integracoes/catalogo/filme", "public", true), "segue");
  assert.equal(decideSurfaceGate("/api/integracoes/catalogo/filme", "admin", true), "segue");
  for (const f of ["scripts/tampermonkey-sync.js", "src/lib/catalog-destino.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /\/api\/integracoes\/catalogo\/episodios\/bulk/, f);
  }
});

test("token de catálogo: aceito só em /api/integracoes/catalogo/*", async () => {
  await withEnv(PUBLIC_OFF, async () => {
    assert.equal(await requireCatalogSync(req("/api/integracoes/catalogo/serie", { authorization: `Bearer ${CATALOG}` }, "POST")), null);
    for (const p of ["/api/admin/serie", "/api/admin/usuarios", "/api/admin/pagamentos/revisoes/r1", "/api/integracoes/outra", "/api/integracoes/catalogox"]) {
      assert.equal((await requireCatalogSync(req(p, { authorization: `Bearer ${CATALOG}` }, "POST")))?.status, 403, p);
    }
  });
});

// ── Escrita máquina→máquina ─────────────────────────────────────────────────

function memoryDb() {
  const filmes = new Map<string, any>();
  const series = new Map<string, any>();
  const eps = new Map<string, any>();
  const table = (m: Map<string, any>) => ({
    findUnique: async ({ where }: any) => m.get(where.id) ?? null,
    upsert: async ({ where, update, create }: any) => { const row = m.has(where.id) ? { ...m.get(where.id), ...update } : { ...create }; m.set(where.id, row); return row; },
  });
  const noop = { deleteMany: async () => ({}), create: async () => ({}), upsert: async () => ({}) };
  const db: any = { filme: table(filmes), serie: table(series), episodio: memoryEpisodeTable(eps), genero: noop, filmeGenero: noop, serieGenero: noop, $transaction: async (fn: any) => fn(db) };
  return { db, filmes, series, eps };
}

test("máquina: null e \"\" não apagam, gêneros vazios não apagam, repetir é idempotente", async () => {
  const { db, filmes } = memoryDb();
  await upsertCatalogMovie({ id: "f", titulo: "F", sinopse: "boa", ano: 2020, urlDub: "d", urlLeg: "l" }, db, CATALOG_WRITE_MAQUINA);
  for (let i = 0; i < 3; i++) {
    const r = await upsertCatalogMovie({ id: "f", titulo: "F", sinopse: null, ano: null, urlDub: "", urlLeg: null, generos: [] }, db, CATALOG_WRITE_MAQUINA);
    assert.equal(r.created, false);
  }
  assert.equal(filmes.size, 1);
  assert.deepEqual([filmes.get("f").sinopse, filmes.get("f").ano, filmes.get("f").urlDub, filmes.get("f").urlLeg], ["boa", 2020, "d", "l"]);
  // Editor humano (padrão) continua podendo limpar com null.
  await upsertCatalogMovie({ id: "f", titulo: "F", urlLeg: null }, db);
  assert.equal(filmes.get("f").urlLeg, null);
});

test("máquina: tipo 'serie' genérico não rebaixa anime/desenho; tipo específico e criação funcionam; humano pode trocar", async () => {
  const { db, series } = memoryDb();
  await upsertCatalogSeries({ id: "a", titulo: "A", tipo: "anime" }, db, CATALOG_WRITE_MAQUINA);
  await upsertCatalogSeries({ id: "a", titulo: "A", tipo: "serie" }, db, CATALOG_WRITE_MAQUINA);
  assert.equal(series.get("a").tipo, "anime");
  await upsertCatalogSeries({ id: "d", titulo: "D", tipo: "desenho" }, db, CATALOG_WRITE_MAQUINA);
  await upsertCatalogSeries({ id: "d", titulo: "D", tipo: "serie" }, db, CATALOG_WRITE_MAQUINA);
  assert.equal(series.get("d").tipo, "desenho");
  await upsertCatalogSeries({ id: "n", titulo: "N", tipo: "serie" }, db, CATALOG_WRITE_MAQUINA);
  assert.equal(series.get("n").tipo, "serie");
  await upsertCatalogSeries({ id: "n", titulo: "N", tipo: "anime" }, db, CATALOG_WRITE_MAQUINA);
  assert.equal(series.get("n").tipo, "anime", "promoção para específico é permitida");
  await upsertCatalogSeries({ id: "a", titulo: "A", tipo: "serie" }, db, { emptyStringClears: true });
  assert.equal(series.get("a").tipo, "serie", "decisão humana explícita vale");
});

test("episódio: WebCine wc_ep_560647 e SuperFlix com outro ID na mesma coordenada = MERGE, nunca segunda linha", async () => {
  const { db, eps } = memoryDb();
  await upsertCatalogEpisodesBulk("s1", [{ id: "wc_ep_560647", temp: 1, ep: 3, urlDub: "https://wc/1x3" }], db, CATALOG_WRITE_MAQUINA);
  const r = await upsertCatalogEpisodesBulk("s1", [{ id: "sf_99-t1e3", temporada: 1, numeroEp: 3, urlLeg: "https://sf/1x3", urlDub: null, titulo: "Três" }], db, CATALOG_WRITE_MAQUINA);
  assert.deepEqual([r.added, r.updated], [0, 1]);
  assert.equal(eps.size, 1);
  const row = eps.get("s1|1|3");
  assert.equal(row.id, "wc_ep_560647", "a linha existente mantém o ID");
  assert.deepEqual([row.urlDub, row.urlLeg, row.titulo], ["https://wc/1x3", "https://sf/1x3", "Três"]);
});

test("rotas de integração e token legado escrevem com semântica de máquina", () => {
  for (const f of ["filme", "serie", "episodios/bulk"]) {
    assert.match(readFileSync(`src/app/api/integracoes/catalogo/${f}/route.ts`, "utf8"), /CATALOG_WRITE_MAQUINA/, f);
  }
  for (const f of ["filme", "serie", "episodio/bulk"]) {
    assert.match(readFileSync(`src/app/api/admin/${f}/route.ts`, "utf8"), /isLegacyAdminTokenRequest\(req\) \? CATALOG_WRITE_MAQUINA/, f);
  }
});
