import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { decideSurfaceGate } from "../../config/obaflix-surface";
import { requireCatalogSync } from "../catalogSyncAuth";
import { requireAdminSession } from "../auth";
import { sanitizeAuditMetadata } from "../admin-action";

const TOKEN = "c".repeat(48);

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const req = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new NextRequest(`https://admin.local${path}`, { method, headers: { "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}`, ...headers } });

// ── Superfície ───────────────────────────────────────────────────────────────

test("superfície admin: só painel, login, auth e integrações; streaming e cadastro dão 404", () => {
  const g = (p: string) => decideSurfaceGate(p, "admin", false);
  assert.equal(g("/"), "painel");
  for (const p of ["/admin", "/login", "/api/auth/session", "/api/admin/usuarios", "/api/integracoes/catalogo/filme"]) assert.equal(g(p), "segue", p);
  for (const p of ["/filmes", "/filme/1", "/serie/1", "/assistir/1", "/player/1", "/cadastro", "/conta", "/buscar", "/api/auth/cadastro", "/api/player/fontes", "/api/billing/me", "/api/cron/sync"]) {
    assert.equal(g(p), "nao_encontrado", p);
  }
});

test("superfície pública: cutover desligado não muda nada; ligado devolve 404 em /admin e /api/admin", () => {
  for (const p of ["/admin", "/api/admin/filme", "/api/admin/usuarios", "/", "/filmes", "/api/player/fontes"]) {
    assert.equal(decideSurfaceGate(p, "public", false), "segue", p);
  }
  for (const p of ["/admin", "/admin/x", "/api/admin/filme", "/api/admin/usuarios"]) assert.equal(decideSurfaceGate(p, "public", true), "nao_encontrado", p);
  for (const p of ["/", "/filmes", "/api/player/fontes", "/administracao"]) assert.equal(decideSurfaceGate(p, "public", true), "segue", p);
});

test("robots: admin bloqueia tudo; público mantém a política atual com sitemap", async () => {
  const { default: robots } = await import("../../app/robots");
  await withEnv({ OBAFLIX_SURFACE: "admin" }, () => {
    assert.deepEqual(robots(), { rules: { userAgent: "*", disallow: "/" } });
  });
  await withEnv({ OBAFLIX_SURFACE: undefined }, () => {
    const r = robots() as any;
    assert.match(String(r.sitemap), /\/sitemap\.xml$/);
    for (const p of ["/api/", "/admin/", "/conta/", "/player/", "/assistir/"]) assert.ok(r.rules.disallow.includes(p), p);
  });
});

test("middleware: matcher não inclui /api inteiro (custo por requisição) e só adiciona /api/admin", () => {
  const src = readFileSync("src/middleware.ts", "utf8");
  const matcher = src.slice(src.indexOf("export const config"));
  assert.match(matcher, /"\/\(\(\?!api\|_next\/static/);
  assert.match(matcher, /"\/api\/admin\/:path\*"/);
});

// ── Guarda humana: sessão + role no banco ─────────────────────────────────────

test("APIs humanas recusam x-admin-token legado, mesmo válido", async () => {
  await withEnv({ OBAFLIX_SURFACE: "public", ADMIN_SECRET_TOKEN: TOKEN }, async () => {
    const r = await requireAdminSession(req("/api/admin/usuarios", { "x-admin-token": TOKEN }), {
      loadSession: async () => { throw new Error("não deveria consultar sessão"); },
    });
    assert.equal(r?.status, 403);
  });
});

test("CATALOG_SYNC_TOKEN não abre APIs humanas: sem sessão é 401", async () => {
  await withEnv({ CATALOG_SYNC_TOKEN: TOKEN }, async () => {
    const variantes: Record<string, string>[] = [{ authorization: `Bearer ${TOKEN}` }, { "x-catalog-sync-token": TOKEN }];
    for (const headers of variantes) {
      const r = await requireAdminSession(req("/api/admin/usuarios", headers), { loadSession: async () => null, roleOf: async () => "admin" });
      assert.equal(r?.status, 401);
    }
  });
});

test("role é revalidado no banco: JWT admin com usuário rebaixado é 403; admin real passa", async () => {
  const session = async () => ({ user: { id: "u1", role: "admin" } });
  assert.equal((await requireAdminSession(req("/api/admin/usuarios"), { loadSession: session, roleOf: async () => "user" }))?.status, 403);
  assert.equal((await requireAdminSession(req("/api/admin/usuarios"), { loadSession: session, roleOf: async () => null }))?.status, 403);
  assert.equal(await requireAdminSession(req("/api/admin/usuarios"), { loadSession: session, roleOf: async () => "admin" }), null);
});

// ── Token de catálogo: escopo ────────────────────────────────────────────────

test("integração de catálogo: sem token e token errado negados; correto permitido só no escopo", async () => {
  await withEnv({ CATALOG_SYNC_TOKEN: TOKEN }, async () => {
    assert.equal((await requireCatalogSync(req("/api/integracoes/catalogo/filme", {}, "POST")))?.status, 403);
    assert.equal((await requireCatalogSync(req("/api/integracoes/catalogo/filme", { authorization: `Bearer ${"x".repeat(48)}` }, "POST")))?.status, 403);
    assert.equal((await requireCatalogSync(req("/api/integracoes/catalogo/filme", { authorization: `Bearer ${TOKEN.slice(1)}` }, "POST")))?.status, 403);
    assert.equal(await requireCatalogSync(req("/api/integracoes/catalogo/filme", { authorization: `Bearer ${TOKEN}` }, "POST")), null);
    assert.equal(await requireCatalogSync(req("/api/integracoes/catalogo/episodios/bulk", { "x-catalog-sync-token": TOKEN }, "POST")), null);
    for (const p of ["/api/admin/usuarios", "/api/admin/usuarios/u1", "/api/admin/reset-password", "/api/admin/assinaturas", "/api/admin/assinaturas/acao", "/api/admin/pagamentos", "/api/admin/pagamentos/revisoes", "/api/admin/auditoria", "/api/admin/filme"]) {
      assert.equal((await requireCatalogSync(req(p, { authorization: `Bearer ${TOKEN}` })))?.status, 403, p);
    }
  });
});

test("token de catálogo curto demais nunca autoriza, nem igual ao configurado", async () => {
  await withEnv({ CATALOG_SYNC_TOKEN: "curto" }, async () => {
    assert.equal((await requireCatalogSync(req("/api/integracoes/catalogo/filme", { authorization: "Bearer curto" }, "POST")))?.status, 403);
  });
});

test("rotas de integração reais negam sem token antes de tocar no banco", async () => {
  await withEnv({ CATALOG_SYNC_TOKEN: TOKEN }, async () => {
    const rotas = [
      await import("../../app/api/integracoes/catalogo/filme/route"),
      await import("../../app/api/integracoes/catalogo/serie/route"),
      await import("../../app/api/integracoes/catalogo/episodios/bulk/route"),
      await import("../../app/api/integracoes/catalogo/heartbeat/route"),
    ];
    for (const rota of rotas) {
      assert.equal((await rota.POST(req("/api/integracoes/catalogo/filme", {}, "POST"))).status, 403, "sem token");
      assert.equal((await rota.POST(req("/api/integracoes/catalogo/filme", { authorization: `Bearer ${"z".repeat(48)}` }, "POST"))).status, 403, "token errado");
      assert.equal((await rota.POST(req("/api/integracoes/catalogo/filme", { "x-admin-token": TOKEN }, "POST"))).status, 403, "token legado admin não serve");
    }
    // Token correto passa a guarda e chega na validação do corpo (sem banco).
    const r = await rotas[0].POST(new NextRequest("https://admin.local/api/integracoes/catalogo/filme", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ id: "" }),
    }));
    assert.equal(r.status, 400);
  });
});

// ── Verificações estáticas das rotas ─────────────────────────────────────────

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

test("APIs humanas novas usam guarda de sessão (sem token legado) e nenhuma rota admin conhece o token de catálogo", () => {
  const humanas = ["usuarios", "assinaturas", "pagamentos/route.ts", "canais", "sincronizacoes", "auditoria", "reset-password"];
  for (const alvo of humanas) {
    const caminho = join("src/app/api/admin", alvo);
    for (const f of caminho.endsWith(".ts") ? [caminho] : files(caminho)) {
      const src = readFileSync(f, "utf8");
      assert.match(src, /requireAdminSession|requireAdminAction/, f);
      assert.doesNotMatch(src, /requireAdmin\(req\)/, f);
    }
  }
  for (const f of files("src/app/api/admin")) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /CATALOG_SYNC_TOKEN|catalogSyncAuth/, f);
  }
  for (const f of files("src/app/api/integracoes")) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /requireCatalogSync\(req\)/, f);
    assert.doesNotMatch(src, /prisma\.(user|assinatura|pedidoPagamento|revisaoPagamento|adminAudit)\b/, f);
  }
});

test("ações sensíveis exigem motivo, auditam e nunca tocam em PedidoPagamento", () => {
  const acao = readFileSync("src/app/api/admin/assinaturas/acao/route.ts", "utf8");
  assert.doesNotMatch(acao, /pedidoPagamento/);
  assert.doesNotMatch(acao, /observacao:\s*motivo/, "motivo vai para a auditoria, não sobrescreve a marca do billing");
  assert.match(acao, /recordAdminAudit/);
  assert.match(acao, /motivo\.length < 5/);
  const reset = readFileSync("src/app/api/admin/reset-password/route.ts", "utf8");
  assert.match(reset, /novaSenha\.length < 12/);
  assert.match(reset, /recordAdminAudit\(\{[^}]*action: "USER_PASSWORD_RESET"[^}]*reason: motivo \}\)/);
  assert.doesNotMatch(reset, /console\.(log|info|warn|error)/);
  assert.doesNotMatch(reset, /metadata:/, "auditoria de senha não leva metadata");
  assert.match(reset, /return NextResponse\.json\(\{ ok: true, email: user\.email\.toLowerCase\(\) \}\);/, "sucesso devolve só ok + e-mail");
  assert.equal(reset.match(/senhaHash/g)?.length, 2, "hash só é calculado e gravado, nunca devolvido nem auditado");
  const page = readFileSync("src/app/admin/page.tsx", "utf8");
  assert.doesNotMatch(page, /x-admin-token/);
});

test("metadata de auditoria descarta senha, hash, cookie, token, secret e URLs", () => {
  const clean = sanitizeAuditMetadata({
    userId: "u1", dias: 30, ok: true,
    senha: "x", novaSenha: "x", password: "x", senhaHash: "x", cookie: "x", sessionToken: "x", jwtToken: "x",
    clientSecret: "x", urlDub: "https://x", streamUrl: "https://x", signedUrl: "https://x", authorization: "Bearer x",
    nested: { a: 1 }, hash: "x", jwt: "x", observacao: "veja https://provider/x.m3u8",
  });
  assert.deepEqual(clean, { userId: "u1", dias: 30, ok: true });
});
