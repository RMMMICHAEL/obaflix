import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { custoMaximoAnalise, custoMicroUsd, gastoDoMes, impressaoDaLegenda, lerLegenda } from "../cortesAi";
import { getRedis } from "../redis";

/**
 * Rota /api/cortes/ia de verdade, com sessão, direitos, Redis e Gemini simulados
 * (nada de banco, nada de rede). Legenda e resposta do Gemini são fictícias.
 * Roda com --experimental-test-module-mocks (ver test:web).
 */
const SRT = "1\n00:00:01,000 --> 00:00:04,000\nOi.\n\n2\n00:00:05,000 --> 00:00:09,000\nTudo certo?\n\n3\n00:00:10,000 --> 00:00:14,000\nVamos.\n\n4\n00:00:15,000 --> 00:00:19,000\nAgora.\n\n5\n00:00:20,000 --> 00:00:24,000\nFim.\n";
let nivel = "ia";
let chamadasGemini = 0;
mock.module("@/lib/authSession", { namedExports: { getUserFromRequest: async () => ({ userId: "u1", origem: "cookie" }) } });
mock.module("@/lib/entitlements", { namedExports: { entitlementsDoUsuario: async () => ({ direitos: { cortesNivel: nivel } }) } });
mock.module("@/lib/playTokens", { namedExports: { isIpBlocked: async () => false, recordAbuseAttempt: async () => {} } });
mock.module("@/lib/auditLog", { namedExports: { audit: () => {} } });
// Legenda automática: catálogo, TMDB e provedor simulados (nenhuma rede, nenhum download real).
const pedidosProvedor: string[] = [];
let geminiRecebeu = "";
mock.module("@/lib/prisma", { namedExports: { prisma: {
  filme: { findUnique: async () => null },
  serie: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === "teste-1396" ? { tmdbId: "1396", imdbId: null } : null) },
  episodio: { findFirst: async ({ where }: { where: { temporada: number; numeroEp: number } }) => (where.temporada === 1 && where.numeroEp === 3 ? { id: "teste-1396-s1e3" } : null) },
} } });
mock.module("@/lib/tmdb", { namedExports: { getIdsExternos: async () => ({ imdb_id: "tt0903747" }) } });
mock.module("@/lib/ssrf", { namedExports: { safeGet: async (url: string, _i: unknown, _r: unknown, permitido: (u: URL) => boolean) => {
  assert.ok(permitido(new URL(url)), `host fora da lista: ${url}`);
  pedidosProvedor.push(url);
  return url.endsWith(".json")
    ? new Response(JSON.stringify({ subtitles: [{ sub_id: 77, lang_code: "pt-br", from_trusted: true, url: "https://opensubtitles.stremio.homes/77.srt" }] }))
    : new Response(SRT);
} } });
const fetchReal = globalThis.fetch;
let modoGemini: "normal" | "timeout" | "json_invalido" | "sem_uso" = "normal";
let aguardarGemini: Promise<void> | null = null;
let avisarGemini: (() => void) | null = null;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  assert.match(String(url), /generativelanguage/);
  chamadasGemini++;
  avisarGemini?.();
  if (aguardarGemini) await aguardarGemini;
  if (modoGemini === "timeout") throw new Error("rede simulada");
  geminiRecebeu = String(init?.body ?? "");
  const cortes = [{ inicio_segundos: 5, fim_segundos: 14, falas: [2, 3], titulo_sugerido: "Vamos", o_que_e_dito: "", motivo: "", confianca: "alta" }];
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: modoGemini === "json_invalido" ? "inválido" : JSON.stringify({ cortes }) }] } }],
    usageMetadata: modoGemini === "sem_uso" ? undefined : { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
  }));
}) as typeof fetch;
test.after(() => { globalThis.fetch = fetchReal; });

process.env.CORTES_AI_ATIVO = "1";
process.env.GEMINI_API_KEY = "chave-falsa";
process.env.CORTES_AI_LEGENDAS_AUTORIZADAS = `titulo-autorizado:${impressaoDaLegenda(SRT)}`;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
test.beforeEach(async () => {
  await getRedis().del(`cortesai:gasto:u1:${new Date().toISOString().slice(0, 7)}`);
  await getRedis().del("http:rate:cortesai:dia:u1");
  modoGemini = "normal";
  aguardarGemini = null;
  avisarGemini = null;
});

const pedir = async (corpo: unknown) => (await import("../../app/api/cortes/ia/route")).POST(new Request("http://localhost/api/cortes/ia", {
  method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost" }, body: JSON.stringify(corpo),
}) as never);

test("legenda autorizada → sugestões validadas", async () => {
  const r = await pedir({ conteudoId: "titulo-autorizado", tema: "tensão", legenda: SRT });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).cortes.map((c: { titulo_sugerido: string }) => c.titulo_sugerido), ["Vamos"]);
});

test("legenda trocada pelo cliente num título autorizado é recusada sem chamar o Gemini", async () => {
  const antes = chamadasGemini;
  const outra = SRT.replace("Oi.", "Texto de terceiros.");
  const r = await pedir({ conteudoId: "titulo-autorizado", tema: "tensão", legenda: outra });
  assert.equal(r.status, 403);
  assert.equal(chamadasGemini, antes);
});

test("sem direito IA → 403 antes de tudo", async () => {
  nivel = "lote";
  const r = await pedir({ conteudoId: "titulo-autorizado", tema: "tensão", legenda: SRT });
  nivel = "ia";
  assert.equal(r.status, 403);
  assert.equal((await r.json()).codigo, "cortes_ai_sem_direito");
});

const BASE_ADDON = "https://opensubtitlesv3-pro.dexter21767.com/eyJjb25maWciOjF9";
const comAutomaticas = async (ligar: boolean, f: () => Promise<void>) => {
  if (ligar) { process.env.CORTES_AI_LEGENDAS_AUTOMATICAS = "1"; process.env.CORTES_AI_LEGENDAS_ADDON = BASE_ADDON; }
  try { await f(); } finally { delete process.env.CORTES_AI_LEGENDAS_AUTOMATICAS; delete process.env.CORTES_AI_LEGENDAS_ADDON; }
};

test("sem legenda no corpo e automáticas desligadas (padrão) → 403, sem provedor e sem Gemini", async () => {
  const [p, g] = [pedidosProvedor.length, chamadasGemini];
  const r = await pedir({ conteudoId: "teste-1396", temporada: 1, episodio: 3, tema: "tensão" });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).codigo, "legenda_nao_autorizada");
  assert.equal(pedidosProvedor.length, p);
  assert.equal(chamadasGemini, g);
});

test("automáticas ligadas: o servidor identifica Breaking Bad T1E3 e busca a legenda ele mesmo", () => comAutomaticas(true, async () => {
  pedidosProvedor.length = 0;
  const r = await pedir({ conteudoId: "teste-1396", temporada: 1, episodio: 3, tema: "tensão" });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).cortes.map((c: { titulo_sugerido: string }) => c.titulo_sugerido), ["Vamos"]);
  assert.deepEqual(pedidosProvedor, [`${BASE_ADDON}/subtitles/series/tt0903747:1:3.json`, "https://opensubtitles.stremio.homes/77.srt"]);
  assert.ok(geminiRecebeu.includes("[3] 10.0-14.0 Vamos."), "o Gemini recebe as falas da legenda do provedor");
}));

test("automáticas ligadas: id fora do catálogo ou episódio inexistente → 404 sem provedor nem Gemini", () => comAutomaticas(true, async () => {
  const [p, g] = [pedidosProvedor.length, chamadasGemini];
  assert.equal((await pedir({ conteudoId: "inventado", temporada: 1, episodio: 3, tema: "tensão" })).status, 404);
  assert.equal((await pedir({ conteudoId: "teste-1396", temporada: 1, episodio: 99, tema: "tensão" })).status, 404);
  assert.equal(pedidosProvedor.length, p);
  assert.equal(chamadasGemini, g);
}));

test("automáticas ligadas não afrouxam o modo com legenda no corpo: texto sem a impressão autorizada → 403", () => comAutomaticas(true, async () => {
  const g = chamadasGemini;
  const r = await pedir({ conteudoId: "teste-1396", temporada: 1, episodio: 3, tema: "tensão", legenda: SRT });
  assert.equal(r.status, 403);
  assert.equal(chamadasGemini, g);
}));

test("teto mensal de gasto atingido → 429 sem chamar o Gemini; o gasto de cada análise é somado", async () => {
  const { getRedis } = await import("../redis");
  const { gastoDoMes } = await import("../cortesAi");
  const antes = await gastoDoMes(getRedis(), "u1");
  process.env.CORTES_AI_TETO_USD_MES = "0.000001";
  try {
    const g = chamadasGemini;
    await getRedis().set(`cortesai:gasto:u1:${new Date().toISOString().slice(0, 7)}`, "1");
    const r = await pedir({ conteudoId: "titulo-autorizado", tema: "tensão", legenda: SRT });
    assert.equal(r.status, 429);
    assert.equal((await r.json()).codigo, "teto_mensal");
    assert.equal(chamadasGemini, g);
  } finally {
    delete process.env.CORTES_AI_TETO_USD_MES;
    await getRedis().set(`cortesai:gasto:u1:${new Date().toISOString().slice(0, 7)}`, String(antes));
  }
});

const corpoValido = { conteudoId: "titulo-autorizado", tema: "tensão", legenda: SRT };
const reservaMaxima = () => custoMaximoAnalise(lerLegenda(SRT), corpoValido.tema);
const chaveMes = () => `cortesai:gasto:u1:${new Date().toISOString().slice(0, 7)}`;

test("duas chamadas simultâneas disputam saldo: só uma chega ao Gemini", async () => {
  await getRedis().set(chaveMes(), String(1_000_000 - reservaMaxima()));
  let liberar!: () => void;
  aguardarGemini = new Promise<void>((resolve) => { liberar = resolve; });
  const entrou = new Promise<void>((resolve) => { avisarGemini = resolve; });
  const antes = chamadasGemini;
  const pedidos = [pedir(corpoValido), pedir(corpoValido)];
  await entrou;
  await new Promise<void>((resolve) => setImmediate(resolve));
  liberar();
  const respostas = await Promise.all(pedidos);
  assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 429]);
  assert.equal(chamadasGemini - antes, 1);
  assert.equal(await gastoDoMes(getRedis(), "u1"), 1_000_000 - reservaMaxima() + 155);
});

test("falha ao reservar fecha antes do Gemini, mesmo se o Redis tiver debitado", async () => {
  const redis = getRedis(), original = redis.reserveBudget.bind(redis);
  redis.reserveBudget = async (...args) => { await original(...args); throw new Error("resposta perdida"); };
  const antes = chamadasGemini;
  try {
    assert.equal((await pedir(corpoValido)).status, 503);
    assert.equal(chamadasGemini, antes);
    assert.equal(await gastoDoMes(redis, "u1"), reservaMaxima());
  } finally { redis.reserveBudget = original; }
});

test("falha de liquidação mantém reserva, devolve resultado pago e protege chamadas seguintes", async () => {
  const redis = getRedis(), original = redis.settleBudget.bind(redis);
  await redis.set(chaveMes(), String(1_000_000 - reservaMaxima()));
  redis.settleBudget = async () => { throw new Error("Redis indisponível"); };
  try {
    assert.equal((await pedir(corpoValido)).status, 200);
    assert.equal(await gastoDoMes(redis, "u1"), 1_000_000);
    const antes = chamadasGemini;
    assert.equal((await pedir(corpoValido)).status, 429);
    assert.equal(chamadasGemini, antes);
  } finally { redis.settleBudget = original; }
});

test("timeout e uso ausente retêm reserva; resposta inválida com uso é cobrada", async () => {
  for (const modo of ["timeout", "sem_uso", "json_invalido"] as const) {
    await getRedis().del(chaveMes());
    modoGemini = modo;
    const r = await pedir(corpoValido);
    assert.equal(r.status, modo === "sem_uso" ? 200 : 502);
    assert.equal(await gastoDoMes(getRedis(), "u1"), modo === "json_invalido" ? custoMicroUsd({ entrada: 100, saida: 50 }) : reservaMaxima());
  }
});

test("padrão continua em cinco análises por 24h e um dólar por mês", async () => {
  const antes = chamadasGemini;
  for (let i = 0; i < 5; i++) assert.equal((await pedir(corpoValido)).status, 200);
  const sexta = await pedir(corpoValido);
  assert.equal(sexta.status, 429);
  assert.equal((await sexta.json()).codigo, "limite_diario");
  assert.equal(chamadasGemini - antes, 5);
  assert.ok(await getRedis().ttl("http:rate:cortesai:dia:u1") > 86_390);
  assert.equal(await gastoDoMes(getRedis(), "u1"), 5 * 155);
});
