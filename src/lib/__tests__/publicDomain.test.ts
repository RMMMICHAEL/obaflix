import { test } from "node:test";
import assert from "node:assert/strict";
import { publicDomainRedirect, publicSiteUrl } from "../../config/public-domain";
import middleware, { config } from "../../middleware";
import { NextRequest, type NextFetchEvent } from "next/server";

for (const host of ["obaflix.online", "obaflix.vercel.app", "www.obaflixbr.com"]) {
  test(`${host}: browser permanent redirect preserves pathname and query`, () => {
    const request = new NextRequest(`https://${host}/filme/abc%20def?x=1&x=2&next=https%3A%2F%2Fevil.test`);
    const response = middleware(request, {} as NextFetchEvent);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://obaflixbr.com/filme/abc%20def?x=1&x=2&next=https%3A%2F%2Fevil.test");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "User-Agent, x-obaflix-client");
  });
}

test("canonical, arbitrary, preview and installer hosts never redirect", () => {
  for (const host of ["obaflixbr.com", "evil.test", "obaflix.online.evil.test", "preview.vercel.app", "app.obaflix.online"]) {
    assert.equal(publicDomainRedirect(new URL(`https://${host}/`)), null);
  }
});

test("legacy clients keep their host with either official UA or header", () => {
  for (const host of ["obaflix.online", "obaflix.vercel.app", "www.obaflixbr.com"]) {
    for (const ua of ["Mozilla/5.0 ObaflixApp/1.0", "Chrome/122 ObaflixDesktop/1.0", "ObaflixTV/0.7.21"]) {
      const req = new NextRequest(`https://${host}/filme/123`, { headers: { "user-agent": ua } });
      assert.equal(middleware(req, {} as NextFetchEvent).headers.get("location"), null);
    }
    for (const client of ["android", "desktop", " ANDROID "]) {
      assert.equal(publicDomainRedirect(new URL(`https://${host}/`), "Mozilla/5.0", client), null);
    }
  }
});

test("API/auth/player routes and admin surface never migrate", () => {
  for (const path of ["/api", "/api/auth/session", "/api/auth/callback/google", "/api/player/proxy", "/api/admin/filmes"]) {
    assert.equal(publicDomainRedirect(new URL(`https://obaflix.online${path}`)), null);
  }
  assert.equal(publicDomainRedirect(new URL("https://obaflix.online/"), null, null, "admin"), null);
});

test("public files migrate for browsers and remain available to TV clients", () => {
  for (const path of ["/robots.txt", "/sitemap.xml", "/sitemap/paginas.xml", "/logo.png", "/manifest.webmanifest"]) {
    const browser = middleware(new NextRequest(`https://obaflix.online${path}`), {} as NextFetchEvent);
    assert.equal(browser.status, 308);
    assert.equal(browser.headers.get("location"), `https://obaflixbr.com${path}`);
    const tv = middleware(new NextRequest(`https://obaflix.online${path}`, { headers: { "user-agent": "ObaflixTV/0.7.21" } }), {} as NextFetchEvent);
    assert.equal(tv.headers.get("location"), null);
    assert.equal(tv.headers.get("x-middleware-next"), "1");
  }
});

test("protocol-relative path and spoofed forwarding headers cannot change target", () => {
  const req = new NextRequest("https://obaflix.online//evil.test/path?q=1", { headers: { "x-forwarded-host": "evil.test" } });
  const response = middleware(req, {} as NextFetchEvent);
  assert.equal(new URL(response.headers.get("location")!).origin, "https://obaflixbr.com");
});

test("SEO origin canonicalizes known production aliases and preserves explicit preview/local", () => {
  for (const origin of [undefined, "https://obaflix.online", "https://obaflix.vercel.app/", "https://www.obaflixbr.com"]) {
    assert.equal(publicSiteUrl(origin), "https://obaflixbr.com");
  }
  assert.equal(publicSiteUrl("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(publicSiteUrl("https://preview.vercel.app/"), "https://preview.vercel.app");
  for (const path of ["/robots.txt", "/sitemap.xml", "/sitemap/:path*"]) assert.ok(config.matcher.includes(path));
});
