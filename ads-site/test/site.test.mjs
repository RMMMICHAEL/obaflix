// Verificações estáticas do obaflix-ads. Sem dependências: node --test ads-site/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const ler = (p) => readFileSync(join(raiz, p), "utf8");
const vercel = JSON.parse(ler("vercel.json"));
const banner = ler("public/banner.html");
const index = ler("public/index.html");

function arquivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? arquivos(p) : [p];
  });
}
const todos = arquivos(raiz).map((p) => relative(raiz, p).split(sep).join("/"));
const publicados = todos.filter((p) => p.startsWith("public/"));

function headersDe(caminho) {
  const out = {};
  for (const regra of vercel.headers) {
    const re = new RegExp(`^${regra.source.replace(/\(\.\*\)/g, ".*")}$`);
    if (re.test(caminho)) for (const h of regra.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}
function diretiva(csp, nome) {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(nome + " "));
  return d ? d.slice(nome.length + 1).split(/\s+/) : null;
}

test("site estático: sem build, sem dependências, só public/ é servido, sem redirect", () => {
  assert.equal(vercel.outputDirectory, "public");
  assert.equal(vercel.buildCommand, null);
  assert.equal(vercel.installCommand, null);
  assert.ok(!("redirects" in vercel) && !("rewrites" in vercel) && !("routes" in vercel));
  assert.ok(!todos.includes("package.json"), "sem package.json/dependências");
  assert.deepEqual(publicados.sort(), ["public/404.html", "public/banner.html", "public/index.html", "public/robots.txt", "public/sw.js"]);
  for (const p of publicados) {
    const txt = ler(p);
    assert.ok(!/http-equiv=["']?refresh/i.test(txt), `${p}: meta refresh`);
    assert.ok(!/location\.(href|replace|assign)\s*[=(]/.test(txt), `${p}: redirect por script`);
  }
});

test("nada do app principal: sem import, API, cookie, storage do Obaflix, segredo ou IPC", () => {
  for (const p of todos.filter((f) => !f.startsWith("test/"))) {
    const txt = ler(p);
    assert.ok(!/\bimport\s|require\(/.test(txt), `${p}: import/require`);
    assert.ok(!/\/api\//.test(txt), `${p}: API`);
    assert.ok(!/document\.cookie|localStorage|sessionStorage/.test(txt), `${p}: cookie/storage`);
    assert.ok(!/obaflixDesktop|ipcRenderer|preload|nodeIntegration/.test(txt.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/.*$/gm, "")) || p === "README.md", `${p}: ponte/IPC`);
    assert.ok(!/(secret|token|password|senha|api[_-]?key)\s*[:=]/i.test(txt), `${p}: segredo`);
  }
});

test("sw.js só verifica a Monetag; sem zonas antigas, registro ou outros formatos", () => {
  for (const p of todos.filter((f) => !f.startsWith("test/"))) {
    const txt = ler(p);
    assert.ok(!txt.includes("11917353"), `${p}: zona do domínio antigo`);
    assert.ok(!txt.includes("11767842"), `${p}: zona de service worker antiga`);
    assert.ok(!/navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(/.test(txt), `${p}: registro de service worker`);
    if (p !== "public/sw.js") {
      assert.ok(!txt.includes("5gvci.com") && !txt.includes("11921240"), `${p}: dados de verificação fora do sw.js`);
    }
  }
  const sw = ler("public/sw.js");
  assert.match(sw, /"domain": "5gvci\.com"/);
  assert.match(sw, /"zoneId": 11921240/);
  assert.match(sw, /importScripts\('https:\/\/5gvci\.com\/act\/files\/service-worker\.min\.js\?r=sw'\)/);
  // Só o código conta: os comentários citam os formatos justamente para proibi-los.
  const codigo = banner.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/multitag|vignette|popunder|onclick|interstitial/i.test(codigo));
});

test("banner: zonas Monetag configuradas; snippet só com a zona da tabela", () => {
  const tabela = /var ZONAS = \{([^}]*)\}/.exec(banner);
  assert.ok(tabela);
  const pares = [...tabela[1].matchAll(/(\w+): '([^']*)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(Object.fromEntries(pares), {
    feed: "11921288",
    detalhe: "11921288",
    player: "11921288",
  });
  assert.match(banner, /if \(!zona\) return;/);
  assert.match(banner, /s\.dataset\.zone=zona/);
  assert.equal((banner.match(/https:\/\/nap5k\.com\/tag\.min\.js/g) || []).length, 1);
});

test("frame-ancestors do banner = lista APP do detector; sem wildcard", () => {
  const csp = headersDe("/banner.html")["content-security-policy"];
  const fa = diretiva(csp, "frame-ancestors");
  const app = JSON.parse(/var APP = (\[[^\]]*\]);/.exec(banner)[1].replace(/'/g, '"'));
  assert.deepEqual([...fa].sort(), [...app].sort());
  assert.ok(fa.includes("https://obaflix.vercel.app"));
  assert.ok(fa.every((o) => /^https:\/\/[a-z0-9.-]+$/.test(o)), "só origens https exatas, sem * e sem 'self'");
  // postMessage só para a origem do pai conferida na lista
  assert.match(banner, /APP\.indexOf\(anc\[0\]\) >= 0/);
  assert.match(banner, /parent\.postMessage\(msg, pai\)/);
  assert.ok(!/postMessage\([^)]*['"]\*['"]/.test(banner));
});

test("CSP do banner: compatível com a tag, sem eval/http/worker/objeto/form/base", () => {
  const csp = headersDe("/banner.html")["content-security-policy"];
  assert.deepEqual(diretiva(csp, "default-src"), ["'none'"]);
  assert.ok(diretiva(csp, "script-src").includes("https:"));
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.ok(!/\bhttp:/.test(csp));
  for (const [d, v] of [["worker-src", "'none'"], ["object-src", "'none'"], ["base-uri", "'none'"], ["form-action", "'none'"]]) {
    assert.deepEqual(diretiva(csp, d), [v], d);
  }
});

test("raiz: não emoldurável, sem script, com ponto de verificação da Monetag", () => {
  for (const c of ["/", "/index.html"]) {
    const csp = headersDe(c)["content-security-policy"];
    assert.deepEqual(diretiva(csp, "frame-ancestors"), ["'none'"], c);
    assert.deepEqual(diretiva(csp, "default-src"), ["'none'"], c);
  }
  assert.ok(!/<script/i.test(index));
  assert.match(index, /VERIFICAÇÃO DA MONETAG/);
});

test("headers globais", () => {
  const h = headersDe("/banner.html");
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.equal(h["referrer-policy"], "strict-origin-when-cross-origin");
  assert.ok(h["strict-transport-security"]);
  assert.ok(!("x-frame-options" in h), "XFO conflitaria com frame-ancestors cross-origin");
});
