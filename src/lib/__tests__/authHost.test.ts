import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { comHostOficial, hostOficialDoPedido } from "../authHost";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { aplicar } = createRequire(import.meta.url)("../../../scripts/patch-next-auth-origin.cjs");

const pedido = (host: string, forwarded?: string) => ({
  headers: { get: (n: string) => (n === "host" ? host : n === "x-forwarded-host" ? forwarded ?? null : null) },
});
const CANONICO = "https://obaflixbr.com";
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A função REAL do next-auth, num arquivo temporário (o node_modules nunca é tocado pelo teste).
const original = path.join(process.cwd(), "node_modules", "next-auth", "utils", "detect-origin.js");
const copia = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "detect-origin-")), "detect-origin.js");
fs.copyFileSync(original, copia);
try { aplicar(copia); } catch (e) { if (!String(e).includes("ja-aplicado")) throw e; }
const detectOrigin: (host: string, proto: string) => string | undefined =
  createRequire(import.meta.url)(copia).detectOrigin;

process.env.NEXTAUTH_URL = CANONICO;

test("o patch é idempotente e se recusa a tocar num arquivo diferente do esperado", () => {
  assert.equal(aplicar(copia), "ja-aplicado");
  const outro = path.join(path.dirname(copia), "outro.js");
  fs.writeFileSync(outro, "function detectOrigin(forwardedHost, protocol) {\n return 1;\n}\n");
  assert.throws(() => aplicar(outro), /diferente do esperado/);
});

test("fora de contexto o next-auth continua usando NEXTAUTH_URL; dentro, o host oficial do próprio pedido", async () => {
  assert.equal(detectOrigin("obaflix.vercel.app", "https"), CANONICO);
  let dentro: string | undefined;
  const h = comHostOficial(async () => { await espera(3); dentro = detectOrigin("x", "https"); return new Response("ok"); }, true);
  await h(pedido("obaflix.vercel.app"));
  assert.equal(dentro, "https://obaflix.vercel.app");
  assert.equal(process.env.NEXTAUTH_URL, CANONICO); // nada global foi escrito
  assert.equal(detectOrigin("obaflix.vercel.app", "https"), CANONICO);
});

test("pedidos simultâneos de hosts diferentes e leitores de fora do contexto não se misturam", async () => {
  const vistos: Record<string, string[]> = {};
  const h = comHostOficial(async (req: ReturnType<typeof pedido>) => {
    const meu = req.headers.get("host")!;
    const leituras: string[] = [];
    for (let i = 0; i < 5; i++) { leituras.push(detectOrigin("x", "https")!); await espera(3 + (i % 3)); }
    vistos[meu] = leituras;
    return new Response("ok");
  }, true);
  const hosts = ["obaflix.vercel.app", "obaflix.online", "obaflixbr.com", "obaflix.vercel.app", "obaflix.online"];
  const fora: string[] = [];
  const observador = (async () => { for (let i = 0; i < 20; i++) { fora.push(detectOrigin("x", "https")!); await espera(2); } })();
  await Promise.all([...hosts.map((x) => h(pedido(x))), observador]);
  for (const [host, leituras] of Object.entries(vistos)) assert.ok(leituras.every((l) => l === `https://${host}`), host);
  assert.ok(fora.every((l) => l === CANONICO), "rotas fora do contexto nunca veem o host trocado");
});

test("host arbitrário, cabeçalho forjado e servidor fora da Vercel nunca viram origem", async () => {
  let visto: string | undefined;
  const h = comHostOficial(async () => { visto = detectOrigin("x", "https"); return new Response("ok"); }, true);
  await h(pedido("evil.example"));
  assert.equal(visto, CANONICO);
  await h(pedido("obaflix.vercel.app", "evil.example")); // x-forwarded-host fora da lista não escolhe nada
  assert.equal(visto, CANONICO);
  await h(pedido("obaflix.vercel.app.evil.example"));
  assert.equal(visto, CANONICO);
  assert.equal(hostOficialDoPedido(pedido("obaflix.vercel.app"), false), null);
  assert.equal(hostOficialDoPedido(pedido("interno", "obaflix.online, evil.example"), true), "obaflix.online");
});

test("falha no tratamento não deixa nada para trás", async () => {
  const h = comHostOficial(async () => { throw new Error("boom"); }, true);
  await assert.rejects(h(pedido("obaflix.online")), /boom/);
  assert.equal(detectOrigin("x", "https"), CANONICO);
});
