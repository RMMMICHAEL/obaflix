import test from "node:test";
import assert from "node:assert/strict";
import { enviarEventoTesteMeta, enviarPurchaseMeta, capturaMetaDaRequisicao } from "../metaCapi";

const compra = { pedidoId: "ped_1", planoId: "cortes-start", valorTotalCentavos: 2799, fbp: "fb.1.1700000000000.1234567890", fbc: null, userAgent: "Mozilla/5.0 (Teste)", em: new Date("2026-10-29T12:00:00Z") };
const resposta = (status: number, corpo: unknown = { events_received: 1 }) => new Response(JSON.stringify(corpo), { status });

test("Purchase: event_id = pedido, valor com taxa em BRL, sem dados pessoais e token só no corpo", async () => {
  let url = "", corpo: any;
  const fetchFalso = (async (u: string, init: any) => { url = u; corpo = JSON.parse(init.body); return resposta(200); }) as unknown as typeof fetch;
  const r = await enviarPurchaseMeta(compra, { fetch: fetchFalso, token: "SEGREDO" });
  assert.deepEqual(r, { ok: true, recebidos: 1 });
  assert.ok(!url.includes("SEGREDO"));
  assert.equal(corpo.access_token, "SEGREDO");
  assert.equal(corpo.test_event_code, undefined);
  const e = corpo.data[0];
  assert.equal(e.event_name, "Purchase");
  assert.equal(e.event_id, "ped_1");
  assert.equal(e.event_source_url, "https://obaflixbr.com/cortes/checkout");
  assert.equal(e.user_data.client_user_agent, "Mozilla/5.0 (Teste)");
  assert.equal(e.custom_data.currency, "BRL");
  assert.equal(e.custom_data.value, 27.99);
  assert.deepEqual(Object.keys(e.user_data).sort(), ["client_user_agent", "external_id", "fbp"]);
  assert.match(e.user_data.external_id[0], /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(e).match(/cpf|telefone|email|client_ip_address/i));
});

test("sem token: configuracao, sem chamar a rede", async () => {
  const ant = process.env.META_CAPI_ACCESS_TOKEN; delete process.env.META_CAPI_ACCESS_TOKEN;
  let chamou = false;
  const r = await enviarPurchaseMeta(compra, { fetch: (async () => { chamou = true; return resposta(200); }) as unknown as typeof fetch });
  if (ant) process.env.META_CAPI_ACCESS_TOKEN = ant;
  assert.deepEqual(r, { ok: false, motivo: "configuracao" });
  assert.equal(chamou, false);
});

test("falhas da Meta: 5xx tenta duas vezes; 4xx não repete; rede cai em indisponivel; nada lança", async () => {
  let n = 0;
  assert.deepEqual(await enviarPurchaseMeta(compra, { token: "t", fetch: (async () => { n++; return resposta(503); }) as unknown as typeof fetch }), { ok: false, motivo: "indisponivel" });
  assert.equal(n, 2);
  n = 0;
  assert.deepEqual(await enviarPurchaseMeta(compra, { token: "t", fetch: (async () => { n++; return resposta(400, { error: { message: "token SEGREDO" } }); }) as unknown as typeof fetch }), { ok: false, motivo: "recusado" });
  assert.equal(n, 1);
  assert.deepEqual(await enviarPurchaseMeta(compra, { token: "t", fetch: (async () => { throw new Error("rede SEGREDO"); }) as unknown as typeof fetch }), { ok: false, motivo: "indisponivel" });
});

test("teste de conexão: PageView com test_event_code, nunca Purchase", async () => {
  let corpo: any;
  await enviarEventoTesteMeta("TESTE123", { token: "t", fetch: (async (_u: string, init: any) => { corpo = JSON.parse(init.body); return resposta(200); }) as unknown as typeof fetch });
  assert.equal(corpo.test_event_code, "TESTE123");
  assert.equal(corpo.data[0].event_name, "PageView");
  assert.equal(corpo.data[0].event_source_url, "https://obaflixbr.com/cortes");
  assert.ok(String(corpo.data[0].event_id).startsWith("capi-teste-"));
});

test("captura: exige _fbp válido (Pixel ativo); fbc e user agent inválidos são descartados", () => {
  const jar = (o: Record<string, string>) => ({ get: (n: string) => (n in o ? { value: o[n] } : undefined) });
  const FBP = "fb.1.1700000000000.1234567890";
  assert.equal(capturaMetaDaRequisicao(jar({}), "Mozilla/5.0"), null);
  assert.equal(capturaMetaDaRequisicao(jar({ _fbp: "lixo" }), "Mozilla/5.0"), null);
  assert.deepEqual(capturaMetaDaRequisicao(jar({ _fbp: FBP, _fbc: "x" })), { fbp: FBP, fbc: null, userAgent: null });
  assert.equal(capturaMetaDaRequisicao(jar({ _fbp: FBP, _fbc: "fb.1.1700000000000.AbC_-1" }), "Mozilla/5.0 (X11; Linux)")?.userAgent, "Mozilla/5.0 (X11; Linux)");
  assert.equal(capturaMetaDaRequisicao(jar({ _fbp: FBP }), "ruim\r\nHeader: x")?.userAgent, null);
  assert.equal(capturaMetaDaRequisicao(jar({ _fbp: FBP }), "a".repeat(513))?.userAgent, null);
});

test("HTTP 200 com events_received 0 ou ausente não é entrega", async () => {
  for (const corpo of [{ events_received: 0 }, {}, null]) {
    const r = await enviarPurchaseMeta(compra, { token: "t", fetch: (async () => resposta(200, corpo)) as unknown as typeof fetch });
    assert.deepEqual(r, { ok: false, motivo: "sem_confirmacao" });
  }
});
