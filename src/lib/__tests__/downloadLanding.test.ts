import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDownloadPublicPath, validatedDownloadUrl, ANDROID_DOWNLOAD_PATH } from "../../config/public-download";
import { verifiedAndroidMetadata } from "../../config/verified-android";
import { INSTALADORES } from "../../config/downloads";
import { publicDownloadMetadata } from "../seo";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
let decidirRota: typeof import("../../config/site-mode").decidirRota;
before(async () => {
  process.env.WEB_STREAMING_ENABLED = "false";
  ({ decidirRota } = await import("../../config/site-mode"));
});

test("download and legal pages are public only at exact paths", () => {
  for (const path of ["/baixar", "/termos", "/privacidade", ANDROID_DOWNLOAD_PATH]) {
    for (const variant of [path, `${path}/`]) {
      assert.equal(isDownloadPublicPath(variant), true);
      assert.deepEqual(decidirRota(variant, "navegador"), { tipo: "segue" });
    }
    for (const variant of [`${path}-falso`, `${path}extra`, `${path}/admin`]) {
      assert.equal(isDownloadPublicPath(variant), false);
      assert.deepEqual(decidirRota(variant, "navegador"), { tipo: "landing" });
    }
  }
});

test("download allowlist rejects hostile URLs", () => {
  const safe = "https://app.obaflix.online/Obaflix-1.0.19-ambiente.apk";
  assert.equal(validatedDownloadUrl(safe), safe);
  assert.equal(validatedDownloadUrl(INSTALADORES.windows.url, "exe"), INSTALADORES.windows.url);
  assert.equal(validatedDownloadUrl("javascript:alert(1)", "exe"), null);
  assert.equal(validatedDownloadUrl("https://app.obaflix.online/file.apk", "exe"), null);
  for (const unsafe of [
    "https://evil.example/file.apk", "https://app.obaflixbr.com/file.apk",
    "https://app.obaflix.online.evil.example/file.apk", "https://evil-app.obaflix.online/file.apk",
    "https://app.obaflix.online@evil.example/file.apk", "https://evil@app.obaflix.online/file.apk",
    "http://app.obaflix.online/file.apk", "//app.obaflix.online/file.apk",
    "javascript:alert(1)", "https://app.obaflix.online:444/file.apk",
    "https://app.obaflix.online/file.apk?url=https://evil.example", "https://app.obaflix.online/file.apk#bad",
    "https://app.obaflix.online/file.exe", "https://app.obaflix.online/%0d%0a.apk",
    "https://app.obaflix.online/file%2Eapk", "not a url",
  ]) assert.equal(validatedDownloadUrl(unsafe), null, unsafe);
});

test("download route returns only a redirect, refuses every query and ignores hostile origin", async () => {
  const { GET } = await import("../../app/download/android/route");
  const result = GET(new Request("https://hostile.example/download/android"));
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("Location"), validatedDownloadUrl(INSTALADORES.android.url));
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.equal(result.body, null);
  assert.equal(await result.text(), "");
  for (const query of ["url=https://evil.example", "next=//evil.example", "redirect=https://evil.example", "url=a&url=b", "foo=bar"]) {
    const refused = GET(new Request(`https://obaflixbr.com/download/android?${query}`));
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get("Location"), null);
  }
  const previous = INSTALADORES.android.url;
  try {
    INSTALADORES.android.url = "https://evil.example/file.apk";
    const closed = GET(new Request("https://obaflixbr.com/download/android"));
    assert.equal(closed.status, 503);
    assert.equal(closed.headers.get("Location"), null);
  } finally { INSTALADORES.android.url = previous; }
});

test("verified metadata disappears if any installer field changes", () => {
  const known = { url: "https://app.obaflix.online/Obaflix-1.0.19-ambiente.apk", versao: "Versão 1.0.19", tamanho: "12,6 MB" };
  assert.equal(verifiedAndroidMetadata(known)?.label, "Versão 1.0.19 · 12,6 MB");
  for (const key of ["url", "versao", "tamanho"] as const) assert.equal(verifiedAndroidMetadata({ ...known, [key]: "unverified" }), null);
});

test("landing has explicit known CTA, legal links and only the approved local product image", () => {
  const page = source("app/baixar/page.tsx");
  const route = source("app/download/android/route.ts");
  const footer = source("components/landing/DownloadFooter.tsx");
  assert.match(page, /href=\{ANDROID_DOWNLOAD_PATH\}/);
  assert.match(page, /INSTALADORES\.androidTv\.url/);
  assert.match(page, /INSTALADORES\.windows\.url/);
  assert.match(footer, /href="\/termos"/);
  assert.match(footer, /href="\/privacidade"/);
  assert.match(footer, /Contato/);
  assert.doesNotMatch(page, /tiktok|reacher|silo|ted lasso|tmdb|prisma|poster|backdrop|<img|<video|iframe|\/api\/player|fetch\(|window\.|useEffect|<script/i);
  assert.deepEqual([...page.matchAll(/<Image\s+src="([^"]+)"/g)].map(match => match[1]), ["/app-mockup.webp"]);
  assert.match(page, /alt="Tela inicial do aplicativo Obaflix"/);
  assert.doesNotMatch(route, /fetch\(|arrayBuffer|ReadableStream|\.blob\(/);
  assert.match(page, /dynamic = "force-static"/);
  const metadata = publicDownloadMetadata("Obaflix", "/baixar");
  assert.deepEqual(metadata.robots, { index: false, follow: true });
  assert.equal(metadata.alternates?.canonical, "/baixar");
  const shell = source("components/layout/PublicDownloadShell.tsx");
  assert.match(shell, /if \(isDownloadPublicPath\(pathname\)\) return <main>\{children\}<\/main>/);
});

test("legacy layouts retain runtime rendering while new documents are static", () => {
  for (const dir of ["admin", "android", "animes", "assistir", "buscar", "cadastro", "canais", "checkout", "colecao", "conta", "desenhos", "desktop", "desktop-auth", "filme", "filmes", "genero", "login", "melhores", "parear", "pessoa", "planos", "player", "serie", "series", "tiktok"]) {
    assert.match(source(`app/${dir}/layout.tsx`), /dynamic = "force-dynamic"/);
  }
  assert.doesNotMatch(source("app/layout.tsx"), /export const dynamic = "force-dynamic"/);
  assert.match(source("app/page.tsx"), /dynamic = "force-dynamic"/);
});

test("legacy Android and Electron routing, APIs and organic landing remain", () => {
  assert.deepEqual(decidirRota("/", "android"), { tipo: "reescreve", para: "/android" });
  assert.deepEqual(decidirRota("/", "desktop"), { tipo: "reescreve", para: "/desktop" });
  for (const env of ["android", "desktop"] as const) {
    for (const path of ["/assistir/title", "/player", "/api/player/proxy", "/api/auth/session"]) assert.deepEqual(decidirRota(path, env), { tipo: "segue" });
  }
  assert.deepEqual(decidirRota("/tiktok", "navegador"), { tipo: "segue" });
  assert.match(source("app/tiktok/page.tsx"), /TikTokPage/);
});

test("legal config stays server-side and only reads public fields", () => {
  const config = source("config/legal.ts");
  assert.match(config, /import "server-only"/);
  for (const field of ["OBAFLIX_LEGAL_NAME", "OBAFLIX_LEGAL_DOCUMENT", "OBAFLIX_LEGAL_ADDRESS", "OBAFLIX_PRIVACY_CONTACT_EMAIL", "OBAFLIX_DPO_NAME"]) assert.match(config, new RegExp(field));
  assert.doesNotMatch(config, /NEXT_PUBLIC|SECRET|TOKEN|DATABASE_URL/);
  for (const path of ["app/termos/page.tsx", "app/privacidade/page.tsx"]) {
    const page = source(path);
    assert.match(page, /force-static/);
    assert.doesNotMatch(page, /prisma|fetch\(|dangerouslySetInnerHTML|\/api\/player/i);
  }
});
