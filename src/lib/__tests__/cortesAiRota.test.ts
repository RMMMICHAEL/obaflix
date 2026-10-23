import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { impressaoDaLegenda } from "../cortesAi";

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
const fetchReal = globalThis.fetch;
globalThis.fetch = (async (url: string) => {
  assert.match(String(url), /generativelanguage/);
  chamadasGemini++;
  const cortes = [{ inicio_segundos: 5, fim_segundos: 14, falas: [2, 3], titulo_sugerido: "Vamos", o_que_e_dito: "", motivo: "", confianca: "alta" }];
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ cortes }) }] } }] }));
}) as typeof fetch;
test.after(() => { globalThis.fetch = fetchReal; });

process.env.CORTES_AI_ATIVO = "1";
process.env.GEMINI_API_KEY = "chave-falsa";
process.env.CORTES_AI_LEGENDAS_AUTORIZADAS = `titulo-autorizado:${impressaoDaLegenda(SRT)}`;

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
