import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { comContexto, configCortesAi, cortesAceitos, custoMicroUsd, FalhaCortesAi, impressaoDaLegenda, lerLegenda, pedirCortes, validarCorte } from "../cortesAi";
import { parsearSugestoesIA } from "../recorte";

/**
 * Cortes AI. Como em `accountDeletion.test.ts`: o comportamento é testado nas
 * funções puras (legenda, validação, chamada com fetch falso) e a forma da rota é
 * lida do fonte (ordem das barreiras, chave só no header, nada sensível no log).
 */

const SRT = "\uFEFF1\r\n00:00:01,000 --> 00:00:04,500\r\n<i>Olá,</i> {\\an8}tudo bem?\r\n\r\n2\r\n00:00:05,000 --> 00:00:09,000\r\nVamos começar &amp; ver.\r\n\r\n3\r\n00:01:00,250 --> 00:01:03,000\r\nFim.\r\n";
const falas = lerLegenda(SRT);

test("lê SRT e VTT com horários originais, sem tags", () => {
  assert.deepEqual(falas.map((f) => [f.id, f.inicio, f.fim, f.texto]), [[1, 1, 4.5, "Olá, tudo bem?"], [2, 5, 9, "Vamos começar & ver."], [3, 60.25, 63, "Fim."]]);
  const vtt = "WEBVTT\n\nNOTE x\n\n00:05.000 --> 00:07.000 align:start\n<v Ana>Primeira fala\n\n01:00:00.000 --> 01:00:02.500\nDepois de uma hora\n";
  assert.deepEqual(lerLegenda(vtt).map((f) => [f.inicio, f.fim, f.texto]), [[5, 7, "Primeira fala"], [3600, 3602.5, "Depois de uma hora"]]);
});

test("corte só vale se as falas citadas o sustentam", () => {
  const base = { inicio_segundos: 1, fim_segundos: 9, falas: [1, 2], titulo_sugerido: "Começo" };
  assert.deepEqual(validarCorte(base, falas), []);
  assert.match(validarCorte({ ...base, falas: [] }, falas).join(), /sem falas/);
  assert.match(validarCorte({ ...base, falas: [9] }, falas).join(), /inexistente/);
  assert.match(validarCorte({ ...base, fim_segundos: 6 }, falas).join(), /não cobre/);
  assert.match(validarCorte({ ...base, fim_segundos: 70 }, falas).join(), /fora da legenda/);
  assert.match(validarCorte({ ...base, fim_segundos: 1.5 }, falas).join(), /duração/);
  assert.match(validarCorte({ ...base, falas: [1, 3], fim_segundos: 63 }, falas, 60).join(), /fora do vídeo/);
  assert.match(validarCorte({ ...base, titulo_sugerido: " " }, falas).join(), /sem título/);
});

test("corte final ganha contexto, fica entre 20 e 90 s e dentro do vídeo", () => {
  // Fala vizinha cortada ao meio entra inteira; curto cresce para os dois lados.
  const longa = lerLegenda([[10, 14], [30, 34], [36, 40], [44, 50]].map(([a, b], i) => `${i + 1}\n00:00:${a},000 --> 00:00:${b},000\nfala ${i + 1}\n`).join("\n"));
  assert.deepEqual(comContexto(30, 40, longa, 600), { inicio: 25, fim: 45 });
  assert.deepEqual(comContexto(36, 40, longa, 600), { inicio: 26.5, fim: 46.5 });
  assert.deepEqual(comContexto(44, 50, longa, 52), { inicio: 32, fim: 52 }, "não passa do fim do vídeo");
  assert.deepEqual(comContexto(1, 5, longa, 600), { inicio: 0, fim: 20 }, "não começa antes de zero");
  assert.deepEqual(comContexto(100, 189, longa, 600), { inicio: 99.5, fim: 189.5 }, "não passa de 90 s");
  const meio = comContexto(12, 40, longa, 600);
  assert.ok(meio.inicio === 9 && meio.fim === 43, JSON.stringify(meio));
});

test("custo em micro-US$ e teto mensal mantêm a tabela e os padrões", () => {
  assert.equal(custoMicroUsd({ entrada: 14_809, saida: 704 }), 6203, "a análise real: ~US$ 0,006");
  assert.equal(configCortesAi({}).tetoMicroUsdMes, 1_000_000);
  assert.equal(configCortesAi({ CORTES_AI_TETO_USD_MES: "2.5" }).tetoMicroUsdMes, 2_500_000);
  assert.equal(configCortesAi({ CORTES_AI_TETO_USD_MES: "-1" }).tetoMicroUsdMes, 1_000_000);
});

test("impressão da legenda ignora BOM e CRLF, mas muda com qualquer texto", () => {
  const lf = "1\n00:00:01,000 --> 00:00:02,000\nOi.\n";
  assert.equal(impressaoDaLegenda("\uFEFF" + lf.replace(/\n/g, "\r\n")), impressaoDaLegenda(lf));
  assert.notEqual(impressaoDaLegenda(lf.replace("Oi.", "Oi!")), impressaoDaLegenda(lf));
  assert.match(impressaoDaLegenda(lf), /^[0-9a-f]{64}$/);
});

test("configuração desligada por padrão; ativa só com flag e chave", () => {
  assert.equal(configCortesAi({}).ativo, false);
  assert.equal(configCortesAi({ CORTES_AI_ATIVO: "1" }).ativo, false);
  assert.equal(configCortesAi({ GEMINI_API_KEY: "k" }).ativo, false);
  const h = "a".repeat(64);
  const c = configCortesAi({ CORTES_AI_ATIVO: "1", GEMINI_API_KEY: "k", CORTES_AI_LEGENDAS_AUTORIZADAS: ` a:${h}, b , c:curto ,`, CORTES_AI_LIMITE_DIA: "x" });
  assert.equal(c.ativo, true);
  assert.deepEqual([...c.legendas], [["a", h]], "sem impressão válida, o conteúdo não fica liberado");
  assert.equal(c.limiteDia, 5);
});

const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

test("uma chamada ao Gemini: chave no header, só texto, aceitos no formato do editor", async () => {
  const chamadas: { url: string; init: RequestInit }[] = [];
  const cortes = [
    { inicio_segundos: 1, fim_segundos: 9, falas: [1, 2], titulo_sugerido: "Começo", o_que_e_dito: "x", motivo: "y", confianca: "alta" },
    { inicio_segundos: 500, fim_segundos: 510, falas: [3], titulo_sugerido: "Inventado" },
  ];
  const r = await pedirCortes(falas, "tema", "CHAVE-SECRETA", {
    fetch: (async (url: string, init: RequestInit) => {
      chamadas.push({ url, init });
      return resposta({ candidates: [{ content: { parts: [{ text: JSON.stringify({ cortes }) }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 } });
    }) as unknown as typeof fetch,
  });
  assert.equal(chamadas.length, 1);
  assert.match(chamadas[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal((chamadas[0].init.headers as Record<string, string>)["x-goog-api-key"], "CHAVE-SECRETA");
  assert.ok(!chamadas[0].url.includes("CHAVE"));
  assert.ok(!String(chamadas[0].init.body).includes("CHAVE"));
  assert.ok(String(chamadas[0].init.body).includes("[2] 5.0-9.0 Vamos começar & ver."));
  assert.deepEqual(r.tokens, { entrada: 120, saida: 30 });

  const { aceitos, rejeitados } = cortesAceitos(r.cortes, falas);
  assert.equal(rejeitados, 1);
  assert.deepEqual(parsearSugestoesIA(JSON.stringify({ cortes: aceitos }), 63), { cenas: [{ inicio: 0, fim: 20, titulo: "Começo" }], ignoradas: 0 });
});

test("falha do Gemini vira código, sem corpo do provedor", async () => {
  const falso = (fn: () => Promise<Response>) => ({ fetch: fn as unknown as typeof fetch });
  await assert.rejects(pedirCortes(falas, "t", "k", falso(async () => resposta({ error: { message: "key=SEGREDO" } }, 429))),
    (e: unknown) => e instanceof FalhaCortesAi && e.codigo === "http" && e.status === 429 && !e.message.includes("SEGREDO"));
  await assert.rejects(pedirCortes(falas, "t", "k", falso(async () => { throw new Error("rede"); })),
    (e: unknown) => e instanceof FalhaCortesAi && e.codigo === "timeout");
  await assert.rejects(pedirCortes(falas, "t", "k", falso(async () => resposta({ candidates: [{ content: { parts: [{ text: "não é json" }] } }] }))),
    (e: unknown) => e instanceof FalhaCortesAi && e.codigo === "resposta_invalida");
});

test("pensamentos são cobrados como saída uma vez; totalTokenCount não duplica entrada", async () => {
  const r = await pedirCortes(falas, "tema", "falsa", { fetch: (async () => resposta({
    candidates: [{ content: { parts: [{ text: '{"cortes":[]}' }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 },
  })) as typeof fetch });
  assert.deepEqual(r.tokens, { entrada: 100, saida: 50 });
  assert.equal(custoMicroUsd(r.tokens!), 155);
});

test("uso ausente ou inválido não vira custo zero; JSON inválido preserva uso cobrado", async () => {
  for (const usageMetadata of [undefined, {}, { promptTokenCount: -1, candidatesTokenCount: 2 }, { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: NaN }]) {
    const r = await pedirCortes(falas, "tema", "falsa", { fetch: (async () => resposta({
      candidates: [{ content: { parts: [{ text: '{"cortes":[]}' }] } }], usageMetadata,
    })) as typeof fetch });
    assert.equal(r.tokens, null);
  }
  await assert.rejects(pedirCortes(falas, "tema", "falsa", { fetch: (async () => resposta({
    candidates: [{ content: { parts: [{ text: "inválido" }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
  })) as typeof fetch }), (e: unknown) => e instanceof FalhaCortesAi && e.tokens?.saida === 50);
});

test("rota: barreiras na ordem certa, limite só antes da chamada, nada sensível no log", () => {
  const rota = readFileSync(join(process.cwd(), "src/app/api/cortes/ia/route.ts"), "utf8");
  const pos = (s: string) => { const i = rota.indexOf(s); assert.ok(i > 0, s); return i; };
  const ordem = ["config.ativo", "headerMatchesHost(origin", "getUserFromRequest(req)", 'cortesNivel !== "ia"', "impressaoDaLegenda(legenda) !== autorizada", "lerLegenda(", "identificarConteudo(", "checkRateLimit(", "buscarLegenda(", "pedirCortes("];
  ordem.reduce((ant, s) => { const i = pos(s); assert.ok(i > ant, `${s} fora de ordem`); return i; }, 0);
  assert.ok(!/console\.(log|error)/.test(rota), "sem console na rota");
  assert.ok(!/detail:[^\n]*(tema|legenda|chave)\b/.test(rota), "detail não leva pedido, legenda ou chave");
  // Falha de limite fecha (503), não libera.
  assert.match(rota, /catch \{\s*return negar\(503, "limite_indisponivel"/);
});
