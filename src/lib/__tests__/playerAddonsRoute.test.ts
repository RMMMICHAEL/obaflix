import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { autorizarAddon } from "../playerAddons";

function route(options: { user?: string | null; session?: boolean; allowed?: boolean; rate?: boolean } = {}) {
  const context = { exports: {} as { POST: (req: Request) => Promise<Response> }, require: (name: string) => {
    const modules: Record<string, unknown> = {
      "next/server": { NextResponse },
      "@/lib/authSession": { getUserFromRequest: async () => options.user === null ? null : { userId: options.user || "owner" } },
      "@/lib/requestSecurity": {
        headerMatchesHost: (origin: string, host: string) => new URL(origin).host === host,
        readJsonBody: (req: Request) => req.json(),
        checkRateLimit: async () => ({ allowed: options.rate !== false }),
      },
      "@/lib/fontes": { alvoAddonDaSessao: async (_session: string, user: string) =>
        options.session === false || user !== "owner" ? null : {
          finalidade: "reproducao", conteudoTipo: "filme", imdbId: "tt1254207", tmdbId: "123", temporada: null, numeroEp: null,
        } },
      "@/lib/playbackAuthorization": { autorizarCatalogo: async () => options.allowed === false
        ? { situacao: "negado" } : { situacao: "permitido", via: "direito" } },
      "@/lib/playerAddons": { autorizarAddon },
      "@/lib/tmdb": { getAddonImdbId: async () => { throw new Error("Não consultar quando IMDb já existe"); } },
    };
    if (!(name in modules)) throw new Error("Import inesperado: " + name);
    return modules[name];
  } };
  const source = readFileSync(join(process.cwd(), "src/app/api/player/addons/route.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  runInNewContext(compiled.outputText, context);
  return (body: unknown = { sessao: "a".repeat(22) }, origin: string | null = "https://app.example") =>
    context.exports.POST(new Request("https://app.example/api/player/addons", {
      method: "POST", headers: { host: "app.example", "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    }));
}

test("rota nega origem ausente/externa, conta ausente e entrada malformada", async () => {
  assert.equal((await route()({}, null)).status, 403);
  assert.equal((await route()({}, "https://evil.example")).status, 403);
  assert.equal((await route({ user: null })()).status, 401);
  assert.equal((await route()({ sessao: "../admin" })).status, 400);
  assert.equal((await route()({})).status, 400);
});
test("rota nega sessão expirada, outro usuário, direito ausente e excesso de chamadas", async () => {
  assert.equal((await route({ session: false })()).status, 403);
  assert.equal((await route({ user: "other" })()).status, 403);
  assert.equal((await route({ allowed: false })()).status, 403);
  assert.equal((await route({ rate: false })()).status, 429);
});
test("tipo, id e URL falsificados no corpo não alteram o alvo autorizado", async () => {
  const response = await route()({ sessao: "a".repeat(22), type: "series", id: "tt999", url: "http://127.0.0.1", finalidade: "download" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: "movie", id: "tt1254207" });
  assert.match(response.headers.get("cache-control") || "", /no-store/);
});
