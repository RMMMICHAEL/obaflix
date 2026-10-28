import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { getRedis } from "../redis";
import { enviarEmail, type MensagemDeEmail } from "../email/enviar";
import { consumirTokenDeAtivacao, emitirTokenDeAtivacao, notificarPrimeiroAcesso, senhaValida, VALIDADE_ATIVACAO_SEG } from "../primeiroAcesso";
import { POST as ativar } from "../../app/api/auth/ativacao/route";
import { POST as reenviar } from "../../app/api/auth/ativacao/reenviar/route";
import { INSTALADORES } from "@/config/downloads";
import { reenviarEmailCompra } from "../billing/reenviarEmailCompra";

const MSG: MensagemDeEmail = { para: "a@b.co", assunto: "s", texto: "t", html: "<p>t</p>" };
const tokenDo = (m: MensagemDeEmail) => /#t=([A-Za-z0-9_-]{43})/.exec(m.texto)?.[1] ?? null;
const pedir = (url: string, corpo: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(corpo), headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" } });
const liberado = async () => ({ allowed: true, remaining: 1 });

describe("enviarEmail", () => {
  test("padrão é simulado: nada sai da máquina", async () => {
    let chamou = false;
    const r = await enviarEmail(MSG, {}, (async () => { chamou = true; return new Response(); }) as typeof fetch);
    assert.deepEqual(r, { ok: true, simulado: true });
    assert.equal(chamou, false);
  });
  test("resend sem chave ou remetente: configuração, sem rede", async () => {
    assert.deepEqual(await enviarEmail(MSG, { EMAIL_MODO: "resend", EMAIL_FROM: "x@obaflixbr.com" }), { ok: false, motivo: "configuracao" });
  });
  test("resend: POST autenticado; recusa e erro de rede viram ok:false", async () => {
    const env = { EMAIL_MODO: "resend", RESEND_API_KEY: "re_teste", EMAIL_FROM: "Obaflix <nao-responda@obaflixbr.com>" };
    let pedido: { url: string; init: RequestInit } | null = null;
    const ok = await enviarEmail(MSG, env, (async (url: string, init: RequestInit) => { pedido = { url, init }; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch);
    assert.deepEqual(ok, { ok: true, simulado: false });
    assert.equal(pedido!.url, "https://api.resend.com/emails");
    assert.equal((pedido!.init.headers as Record<string, string>).Authorization, "Bearer re_teste");
    assert.deepEqual(JSON.parse(pedido!.init.body as string).to, ["a@b.co"]);
    assert.deepEqual(await enviarEmail(MSG, env, (async () => new Response("", { status: 422 })) as typeof fetch), { ok: false, motivo: "recusado" });
    assert.deepEqual(await enviarEmail(MSG, env, (async () => { throw new Error("x"); }) as typeof fetch), { ok: false, motivo: "rede" });
  });
});

describe("token de ativação", () => {
  test("uso único, só hash no Redis, validade de 30 min", async () => {
    const redis = getRedis();
    const token = await emitirTokenDeAtivacao("u-1");
    assert.equal(await redis.get(`ativacao:token:${token}`), null);
    const ttl = await redis.ttl("ativacao:conta:u-1");
    assert.ok(ttl > VALIDADE_ATIVACAO_SEG - 5 && ttl <= VALIDADE_ATIVACAO_SEG);
    assert.equal(await consumirTokenDeAtivacao(token), "u-1");
    assert.equal(await consumirTokenDeAtivacao(token), null);
  });
  test("consumo concorrente: só um vence", async () => {
    const token = await emitirTokenDeAtivacao("u-2");
    const r = await Promise.all([consumirTokenDeAtivacao(token), consumirTokenDeAtivacao(token), consumirTokenDeAtivacao(token)]);
    assert.deepEqual(r.filter(Boolean), ["u-2"]);
  });
  test("novo link invalida o anterior; token alterado ou malformado não vale", async () => {
    const velho = await emitirTokenDeAtivacao("u-3");
    const novo = await emitirTokenDeAtivacao("u-3");
    assert.equal(await consumirTokenDeAtivacao(velho), null);
    const alterado = (novo[0] === "A" ? "B" : "A") + novo.slice(1);
    for (const ruim of [alterado, "", "curto", 123, null, novo + "x"]) assert.equal(await consumirTokenDeAtivacao(ruim), null);
    assert.equal(await consumirTokenDeAtivacao(novo), "u-3");
  });
  test("senha segue a regra do cadastro", () => {
    assert.equal(senhaValida("abc12345"), true);
    for (const ruim of ["abc1234", "abcdefgh", "12345678", "a1".repeat(65), 12345678]) assert.equal(senhaValida(ruim), false);
  });
});

describe("notificarPrimeiroAcesso", () => {
  test("recibo HTML/texto usa plano, período, valor do pedido e download central; escapa HTML", async () => {
    const enviados: MensagemDeEmail[] = [];
    const compra = { pedidoId: "pedido-email", plano: "Cortes Pro <script>", valorCentavos: 4321, valorTotalCentavos: 4420, moeda: "BRL", iniciaEm: new Date("2026-10-28T12:00:00Z"), terminaEm: new Date("2026-11-27T12:00:00Z") };
    for (const semSenha of [true, false]) {
      const r = await notificarPrimeiroAcesso({ userId: `recibo-${semSenha}`, email: "recibo@example.test", semSenha, compra }, { base: "https://obaflixbr.com", enviar: async m => { enviados.push(m); return { ok: true, simulado: true }; } });
      assert.equal(r.ok, true);
    }
    for (const m of enviados) {
            assert.match(m.assunto, /Obaflix Cortes/);
      assert.match(m.texto, /44,20/);
      assert.match(m.html, /Ativar conta e criar senha|Entrar no Obaflix/);
      assert.match(m.texto, /43,21/);
      assert.match(m.texto, /28\/10\/2026 a 27\/11\/2026/);
      assert.ok(m.texto.includes(INSTALADORES.windowsCortes.url));
      assert.ok(m.html.includes(INSTALADORES.windowsCortes.url));
      assert.match(m.html, /Cortes Pro &lt;script&gt;/);
      assert.doesNotMatch(m.html, /<script>|senhaHash|CPF|transacaoId/);
    }
    assert.ok(tokenDo(enviados[0]));
    assert.equal(tokenDo(enviados[1]), null);
    assert.match(enviados[1].texto, /forma habitual de login/);
  });
  test("conta sem senha: link de ativação válido; com senha: só orientação de login", async () => {
    const enviados: MensagemDeEmail[] = [];
    const enviar = async (m: MensagemDeEmail) => { enviados.push(m); return { ok: true as const, simulado: true }; };
    await notificarPrimeiroAcesso({ userId: "u-4", email: "n@x.co", semSenha: true }, { enviar, base: "https://obaflix.online/" });
    assert.ok(enviados[0].html.includes("https://obaflix.online/ativar#t="));
    assert.ok(enviados[0].texto.includes("Obaflix-Setup-1.0.16.exe"));
    assert.ok(enviados[0].html.includes("Obaflix-Setup-1.0.16.exe"));
    assert.equal(await consumirTokenDeAtivacao(tokenDo(enviados[0])), "u-4");
    await notificarPrimeiroAcesso({ userId: "u-5", email: "e@x.co", semSenha: false }, { enviar, base: "https://obaflix.online" });
    assert.equal(tokenDo(enviados[1]), null);
    assert.ok(enviados[1].texto.includes("https://obaflix.online/login"));
    assert.ok(enviados[1].texto.includes("Obaflix-Setup-1.0.16.exe"));
    assert.ok(enviados[1].html.includes("Obaflix-Setup-1.0.16.exe"));
    assert.equal(await getRedis().get("ativacao:conta:u-5"), null);
  });
  test("falha de envio ou sem base: ok:false, nunca lança", async () => {
    const r = await notificarPrimeiroAcesso({ userId: "u-6", email: "n@x.co", semSenha: true }, { enviar: async () => { throw new Error("x"); }, base: "https://a.b" });
    assert.equal(r.ok, false);
    assert.deepEqual(await notificarPrimeiroAcesso({ userId: "u-6", email: "n@x.co", semSenha: true }, { base: "" }), { ok: false, motivo: "configuracao" });
  });
});

test("reenvio operacional só aceita Cortes pago e vinculado; não altera conta ou assinatura", async () => {
  const pago = { id: "p-reenvio", status: "PAGO", userId: "u-r", planoId: "cortes-start", planoPrecoId: "preco", valorCentavos: 2700, moeda: "BRL",
    user: { email: "reenvio@example.test", senhaHash: "h" }, plano: { nome: "Cortes Start", cortesNivel: "individual" },
    assinatura: { pedidoId: "p-reenvio", userId: "u-r", planoId: "cortes-start", planoPrecoId: "preco", iniciaEm: new Date("2026-10-28"), terminaEm: new Date("2026-11-27") } };
  const antes = JSON.stringify(pago);
  const avisos: any[] = [];
  const notificar = async (c: any) => { avisos.push(c); return { ok: true as const, simulado: true }; };
  const banco = (p: any): any => ({ pedidoPagamento: { findUnique: async () => p } });
  for (const p of [null, { ...pago, status: "AGUARDANDO" }, { ...pago, status: "ESTORNADO" }, { ...pago, assinatura: null }, { ...pago, assinatura: { ...pago.assinatura, userId: "outro" } }]) {
    assert.equal((await reenviarEmailCompra("p-reenvio", { banco: banco(p), notificar })).ok, false);
  }
  assert.equal(avisos.length, 0);
  assert.equal((await reenviarEmailCompra("p-reenvio", { banco: banco(pago), notificar })).ok, true);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].compra.valorCentavos, 2700);
  assert.equal(avisos[0].semSenha, false);
  assert.equal(JSON.stringify(pago), antes);
});

describe("POST /api/auth/ativacao", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const banco = (contas: Record<string, string | null>): any => ({ user: { updateMany: async ({ where, data }: { where: { id: string }; data: { senhaHash: string } }) => {
    if (!(where.id in contas) || contas[where.id] !== null) return { count: 0 };
    contas[where.id] = data.senhaHash;
    return { count: 1 };
  } } });

  test("cria a senha uma vez; link reusado falha", async () => {
    const contas: Record<string, string | null> = { "u-7": null };
    const h = ativar.createForTest({ prisma: banco(contas), limitar: liberado });
    const token = await emitirTokenDeAtivacao("u-7");
    assert.equal((await h(pedir("/api/auth/ativacao", { token, senha: "segura123" }))).status, 200);
    assert.match(contas["u-7"]!, /^\$2[aby]\$/);
    assert.equal((await h(pedir("/api/auth/ativacao", { token, senha: "segura123" }))).status, 400);
  });
  test("senha fraca não queima o link", async () => {
    const contas: Record<string, string | null> = { "u-8": null };
    const h = ativar.createForTest({ prisma: banco(contas), limitar: liberado });
    const token = await emitirTokenDeAtivacao("u-8");
    assert.equal((await h(pedir("/api/auth/ativacao", { token, senha: "fraca" }))).status, 400);
    assert.equal((await h(pedir("/api/auth/ativacao", { token, senha: "segura123" }))).status, 200);
  });
  test("conta que já tem senha não é alterada", async () => {
    const contas: Record<string, string | null> = { "u-9": "hash-antigo" };
    const h = ativar.createForTest({ prisma: banco(contas), limitar: liberado });
    const token = await emitirTokenDeAtivacao("u-9");
    assert.equal((await h(pedir("/api/auth/ativacao", { token, senha: "segura123" }))).status, 400);
    assert.equal(contas["u-9"], "hash-antigo");
  });
  test("limite por IP", async () => {
    const h = ativar.createForTest({ prisma: banco({}), limitar: async () => ({ allowed: false, remaining: 0 }) });
    assert.equal((await h(pedir("/api/auth/ativacao", { token: "x", senha: "segura123" }))).status, 429);
  });
});

describe("POST /api/auth/ativacao/reenviar", () => {
  test("mesma resposta sempre; só conta sem senha recebe link", async () => {
    const avisados: string[] = [];
    const contas: Record<string, { id: string; senhaHash: string | null }> = { "sem@x.co": { id: "u-s", senhaHash: null }, "com@x.co": { id: "u-c", senhaHash: "h" } };
    const h = reenviar.createForTest({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: { user: { findUnique: async ({ where }: { where: { email: string } }) => contas[where.email] ?? null } } as any,
      notificar: async (c) => { avisados.push(c.userId); return { ok: true, simulado: true }; },
      limitar: liberado,
    });
    const respostas: string[] = [];
    for (const email of [" SEM@x.co ", "com@x.co", "ninguem@x.co", "invalido"]) {
      const r = await h(pedir("/api/auth/ativacao/reenviar", { email }));
      respostas.push(`${r.status} ${await r.text()}`);
    }
    assert.equal(new Set(respostas).size, 1);
    assert.deepEqual(avisados, ["u-s"]);
  });
});
