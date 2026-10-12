import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { NextRequest, type NextFetchEvent } from "next/server";

let middleware: typeof import("../../middleware").default;
let middlewareConfig: typeof import("../../middleware").config;
before(async () => {
  process.env.WEB_STREAMING_ENABLED = "false";
  process.env.OBAFLIX_SURFACE = "public";
  process.env.PUBLIC_CUTOVER_ATIVO = "false";
  ({ default: middleware, config: middlewareConfig } = await import("../../middleware"));
});
const event = {} as NextFetchEvent;
function request(url: string, headers: Record<string, string> = {}, method = "GET") {
  return middleware(new NextRequest(url, { method, headers: { host: new URL(url).host, ...headers } }), event);
}

test("308 dos hosts duplicados para documentos públicos, preservando path e query", () => {
  for (const host of ["obaflix.vercel.app", "www.obaflixbr.com"]) {
    for (const protocol of ["http", "https"]) {
      for (const path of ["/", "/filmes", "/series", "/filme/bigfoot--12986", "/serie/silo--158", "/genero/terror--5"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = request(`${protocol}://${host}${path}?page=2&utm_source=teste&x=%2F`, {}, method);
          assert.equal(response.status, 308);
          assert.equal(response.headers.get("cache-control"), "private, no-store");
          assert.equal(response.headers.get("location"), `https://obaflixbr.com${path}?page=2&utm_source=teste&x=%2F`);
        }
      }
    }
  }
});

test("domínio oficial, aliases não escolhidos e previews não redirecionam nem geram loop", () => {
  for (const host of ["obaflixbr.com", "obaflix.online", "obaflix-preview.vercel.app", "localhost:3000"]) {
    assert.equal(request(`https://${host}/filmes`).headers.get("location"), null);
  }
  const first = request("https://obaflix.vercel.app/genero/acao--1?page=2");
  const destination = first.headers.get("location")!;
  assert.equal(request(destination).headers.get("location"), null);
});

test("host exato, sem confiar em forwarded-host ou autoridade malformada", () => {
  for (const host of ["obaflix.vercel.app.evil.test", "evil@obaflix.vercel.app", "obaflix.vercel.app,evil.test", "obaflix.vercel.app:3000"]) {
    assert.equal(request("https://obaflixbr.com/", { host }).headers.get("location"), null);
  }
  assert.equal(request("https://obaflixbr.com/", { "x-forwarded-host": "obaflix.vercel.app" }).headers.get("location"), null);
  assert.equal(request("https://obaflix.vercel.app/", { host: "OBAFLIX.VERCEL.APP:443" }).status, 308);
});

test("mobile e Googlebot recebem a mesma regra do navegador, sem exceção de crawler", () => {
  for (const ua of ["Mozilla/5.0 Windows Chrome", "Mozilla/5.0 Android Mobile", "Googlebot/2.1", "Mozilla/5.0 Googlebot Smartphone"]) {
    assert.equal(request("https://obaflix.vercel.app/filmes", { "user-agent": ua, accept: "text/html" }).status, 308);
  }
});

test("Android, TV e Electron preservam raiz reescrita, catálogo e players", () => {
  const clients: Record<string, string>[] = [{ "user-agent": "ObaflixApp/1.0.19" }, { "user-agent": "ObaflixDesktop/1.0.13" }, { "x-obaflix-client": "android" }, { "x-obaflix-client": "desktop" }];
  for (const headers of clients) {
    const root = request("https://obaflix.vercel.app/", headers);
    assert.equal(root.headers.get("location"), null);
    assert.match(root.headers.get("x-middleware-rewrite")!, /\/(android|desktop)$/);
    for (const path of ["/filmes", "/serie/silo--158", "/assistir/filme/123", "/player", "/api/player/proxy", "/api/tv/session"]) {
      assert.equal(request(`https://obaflix.vercel.app${path}`, headers).headers.get("location"), null);
    }
  }
});

test("sessões, cookies fragmentados e estados OAuth não migram de origem", () => {
  for (const name of ["next-auth.session-token", "__Secure-next-auth.session-token.0", "__Host-next-auth.csrf-token", "__Secure-next-auth.callback-url", "next-auth.state", "next-auth.pkce.code_verifier"]) {
    assert.equal(request("https://obaflix.vercel.app/", { cookie: `${name}=test-only` }).headers.get("location"), null);
  }
});

test("APIs, bootstrap OAuth, conta, pareamento, sitemap, robots e recursos ficam intactos", () => {
  for (const path of ["/api/auth/callback/google", "/api/desktop-auth/exchange", "/api/cron/sync", "/api/player/proxy", "/api/tv/session", "/login", "/cadastro", "/desktop-auth", "/conta", "/checkout", "/parear", "/robots.txt", "/sitemap/series-1.xml", "/sw.js"]) {
    assert.equal(request(`https://obaflix.vercel.app${path}`).headers.get("location"), null, path);
  }
  for (const path of ["/filmes-falso", "/filme-falso/id", "/filme/id/extra", "/baixar", "/tiktok", "/termos"]) {
    const response = request(`https://obaflix.vercel.app${path}`);
    assert.notEqual(response.status, 308, path);
  }
});

test("requisições não HTML, RSC e métodos de escrita não entram na regra", () => {
  for (const method of ["POST", "PUT", "OPTIONS"]) {
    assert.equal(request("https://obaflix.vercel.app/filmes", {}, method).headers.get("location"), null);
  }
  const requests: Record<string, string>[] = [{ accept: "application/json" }, { accept: "text/x-component" }, { rsc: "1", accept: "*/*" }];
  for (const headers of requests) {
    assert.equal(request("https://obaflix.vercel.app/filmes", headers).headers.get("location"), null);
  }
});

test("matcher existente mantém XML, robots e assets fora do middleware", () => {
  const pageMatcher = new RegExp(`^${middlewareConfig.matcher[0]}$`);
  for (const path of ["/sitemap.xml", "/sitemap/paginas.xml", "/robots.txt", "/_next/static/chunk.js", "/favicon.ico"]) {
    assert.equal(pageMatcher.test(path), false, path);
  }
});

test("superfície admin continua bloqueando catálogo", () => {
  process.env.OBAFLIX_SURFACE = "admin";
  try { assert.equal(request("https://obaflix.vercel.app/filmes").status, 404); }
  finally { process.env.OBAFLIX_SURFACE = "public"; }
});

test("reabertura futura do streaming web não troca a origem da experiência autenticada", () => {
  execFileSync(process.execPath, ["--import", "tsx", "-e", "const {publicCanonicalUrl}=require('./src/config/public-canonical.ts'); if(publicCanonicalUrl({host:'obaflix.vercel.app',method:'GET',pathname:'/',search:'',ambiente:'navegador',accept:null,rsc:null,cookieNames:[]})!==null)process.exit(1)"], {
    cwd: process.cwd(), env: { ...process.env, WEB_STREAMING_ENABLED: "true" },
  });
});
