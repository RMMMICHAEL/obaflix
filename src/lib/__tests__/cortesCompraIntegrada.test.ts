// Fluxo Cortes sem login de ponta a ponta, em memória: serviço do pedido (o mesmo
// da rota) → provedor simulado → rota de pagamento simulado → rota do webhook →
// confirmação → primeiro acesso por e-mail simulado. Nada de rede, banco ou Neon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { criarPedidoPix, type NovoPedido, type PrecoDoBanco, type RepositorioDePedidos } from "../billing/pedidos";
import { criarConfirmadorSimulado, criarProvedorSimulado } from "../billing/simulado";
import { confirmarPedidoPorId } from "../billing/confirmacao";
import { executarAcaoDeRevisao } from "../billing/revisaoAcoes";
import { emailDoComprador } from "../billing/pagador";
import { enviarEmail, type MensagemDeEmail } from "../email/enviar";
import { consumirTokenDeAtivacao, notificarPrimeiroAcesso } from "../primeiroAcesso";
import { getRedis } from "../redis";
import { POST as pagamentoSimulado } from "../../app/api/teste/pagamento-simulado/route";
import { POST as webhook } from "../../app/api/billing/webhook/blackcat/[segredo]/route";

const TOKEN_TESTE = "t".repeat(40);
const SEGREDO = "segredo-do-webhook";
const DIA = 86_400_000;

function criarMundo() {
  const planos: Record<string, { id: string; nome: string; ativo: boolean; ordem: number; cortesNivel: string }> = {
    basic: { id: "basic", nome: "Basic", ativo: true, ordem: 1, cortesNivel: "nenhum" },
    "cortes-start": { id: "cortes-start", nome: "Obaflix Cortes Start", ativo: true, ordem: 10, cortesNivel: "individual" },
  };
  // Preço fictício só em memória.
  const precos: Record<string, Omit<PrecoDoBanco, "plano">> = {
    "pp-cortes": { id: "pp-cortes", planoId: "cortes-start", rotulo: "Teste", precoCentavos: 100, duracaoDias: 30, duracaoMeses: null, moeda: "BRL", ativo: true },
  };
  const users: { id: string; email: string; nome?: string | null; senhaHash: string | null }[] = [];
  const pedidos: (NovoPedido & { id: string; transacaoId?: string | null; expiraEm?: Date | null; status: string })[] = [];
  const assinaturas: { id: string; userId: string; planoId: string; status: string; terminaEm: Date; pedidoId?: string | null; [k: string]: unknown }[] = [];
  const eventos: string[] = [];
  const revisoes: { id: string; pedidoId: string; userId: string | null; status: string }[] = [];
  const kv = new Map<string, string>();
  const redis = { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => { kv.set(k, v); } };
  const enviados: MensagemDeEmail[] = [];
  const naRede: string[] = [];

  const comVinculos = (p: (typeof pedidos)[number] | undefined) =>
    p && { ...p, assinatura: assinaturas.find((a) => a.pedidoId === p.id) ?? null, plano: { cortesNivel: planos[p.planoId].cortesNivel } };

  // Mesmo contrato do repositório da rota, sobre as tabelas em memória.
  const repo: RepositorioDePedidos = {
    buscarPreco: async (id) => (precos[id] ? { ...precos[id], plano: planos[precos[id].planoId] } : null),
    buscarAdicionais: async () => ({ telaMensalCentavos: null, servidorVipMensalCentavos: null }),
    periodosEmAberto: async (userId, agora) => assinaturas
      .filter((a) => a.userId === userId && a.status === "ATIVA" && a.terminaEm > agora)
      .map((a) => ({ id: a.id, planoId: a.planoId, ordemDoPlano: planos[a.planoId].ordem, cortes: planos[a.planoId].cortesNivel !== "nenhum", iniciaEm: new Date(), terminaEm: a.terminaEm, valorPagoCentavos: 0 })),
    revisaoPendente: async (userId) => revisoes.some((r) => r.userId === userId && r.status === "PENDENTE"),
    criar: async (dados) => { const id = `pedido-${pedidos.length + 1}`; pedidos.push({ ...dados, id }); return { id }; },
    registrarVenda: async (id, { transacaoId, expiraEm }) => { Object.assign(pedidos.find((p) => p.id === id)!, { status: "AGUARDANDO", transacaoId, expiraEm }); },
    registrarFalha: async () => { assert.fail("provedor simulado não falha"); },
  };

  // Prisma em memória: só o que webhook e confirmação usam.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const banco: any = {
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(banco),
    pedidoPagamento: {
      findUnique: async ({ where }: { where: { id?: string; transacaoId?: string } }) =>
        comVinculos(pedidos.find((p) => (where.id ? p.id === where.id : p.transacaoId === where.transacaoId))) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: object }) => comVinculos(Object.assign(pedidos.find((p) => p.id === where.id)!, data)),
    },
    eventoPagamento: {
      create: async ({ data }: { data: { provedor: string; transacaoId: string; evento: string; statusInformado: string } }) => {
        const chave = `${data.provedor}|${data.transacaoId}|${data.evento}|${data.statusInformado}`;
        if (eventos.includes(chave)) throw { code: "P2002", meta: { target: ["provedor", "transacaoId", "evento", "statusInformado"] } };
        eventos.push(chave);
      },
    },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null,
      upsert: async ({ where, create }: { where: { email: string }; create: { email: string; nome?: string | null } }) => {
        let u = users.find((x) => x.email === where.email);
        if (!u) { u = { id: `user-${users.length + 1}`, senhaHash: null, ...create }; users.push(u); }
        return { id: u.id, senhaHash: u.senhaHash };
      },
    },
    assinatura: {
      findMany: async ({ where }: { where: { userId: string; status: string; terminaEm: { gt: Date }; plano: { cortesNivel: string | { not: string } } } }) =>
        assinaturas.filter((a) => {
          const nivel = planos[a.planoId].cortesNivel, f = where.plano.cortesNivel;
          return a.userId === where.userId && a.status === where.status && a.terminaEm > where.terminaEm.gt && (typeof f === "string" ? nivel === f : nivel !== f.not);
        }),
      create: async ({ data }: { data: { pedidoId: string; userId: string; planoId: string; status: string; terminaEm: Date } }) => {
        if (assinaturas.some((a) => a.pedidoId === data.pedidoId)) throw { code: "P2002", meta: { target: ["pedidoId"] } };
        const a = { id: `assinatura-${assinaturas.length + 1}`, ...data };
        assinaturas.push(a);
        return a;
      },
      update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(assinaturas.find((a) => a.id === where.id)!, data),
    },
    revisaoPagamento: {
      findFirst: async ({ where }: { where: { pedidoId?: string; status?: string } }) => revisoes.find((r) => r.pedidoId === where.pedidoId && (!where.status || r.status === where.status)) ?? null,
      create: async ({ data }: { data: { pedidoId: string; userId: string | null } }) => { const r = { id: `rev-${revisoes.length + 1}`, status: "PENDENTE", ...data }; revisoes.push(r); return r; },
      updateMany: async ({ where, data }: { where: { pedidoId: string; userId: null }; data: object }) => {
        const alvo = revisoes.filter((r) => r.pedidoId === where.pedidoId && r.userId === where.userId);
        alvo.forEach((r) => Object.assign(r, data));
        return { count: alvo.length };
      },
    },
    revisaoPagamentoEvento: { create: async () => ({}) },
  };

  // Nenhuma chamada de rede: e-mail em modo simulado; qualquer fetch falharia o teste.
  const semRede = (async (url: string) => { naRede.push(String(url)); throw new Error("rede proibida no teste"); }) as unknown as typeof fetch;
  const confirmar = (pedidoId: string) => confirmarPedidoPorId(pedidoId, {
    prisma: banco,
    consultarStatusBlackcat: criarConfirmadorSimulado(redis),
    invalidarEntitlements: async () => {},
    notificarPrimeiroAcesso: (c) => notificarPrimeiroAcesso(c, {
      enviar: async (m) => { enviados.push(m); return enviarEmail(m, { EMAIL_MODO: "simulado" }, semRede); },
      redis: getRedis(),
      base: "https://obaflix.test",
    }),
  });

  const pagar = async (transacaoId: string) => {
    const h = pagamentoSimulado.createForTest({ redis, env: { PAGAMENTO_SIMULADO: "true", OBAFLIX_AMBIENTE: "teste", VERCEL_ENV: "preview", TESTE_PAGAMENTO_TOKEN: TOKEN_TESTE } });
    return h(new NextRequest("http://local/api/teste/pagamento-simulado", {
      method: "POST", headers: { "content-type": "application/json", "x-teste-token": TOKEN_TESTE },
      body: JSON.stringify({ transacaoId, status: "PAID" }),
    }));
  };

  const avisarWebhook = async (transactionId: string, evento = "transaction.paid") => {
    const h = webhook.createForTest({
      prisma: banco, confirmarPedidoPorId: confirmar, checkRateLimit: async () => ({ allowed: true, remaining: 1 }), clientIp: () => "203.0.113.7",
      env: { BLACKCAT_CONFIRMACAO_ATIVA: "true", BLACKCAT_WEBHOOK_PATH_SECRET: SEGREDO },
    });
    return h(new NextRequest(`http://local/api/billing/webhook/blackcat/${SEGREDO}`, {
      method: "POST", headers: { "content-type": "application/json", "x-webhook-source": "blackcat-api", "x-webhook-event": evento },
      body: JSON.stringify({ transactionId, status: "PAID" }),
    }), { params: { segredo: SEGREDO } });
  };

  const comprar = async (email: string, userId: string | null = null) => {
    const r = await criarPedidoPix({
      userId, planoId: "cortes-start", planoPrecoId: "pp-cortes",
      ...(userId ? {} : { comprador: { email: emailDoComprador(email)!, nome: "Comprador Teste", nascimento: new Date("1990-05-17T00:00:00Z") } }),
      pagador: { nome: "Comprador Teste", email: emailDoComprador(email)!, telefone: "11999999999", documento: { numero: "52998224725", tipo: "cpf" } },
    }, { repo, provedor: criarProvedorSimulado(redis), nomeDoProvedor: "simulado" });
    assert.equal(r.situacao, "criado");
    return pedidos.find((p) => p.id === (r as { pedidoId: string }).pedidoId)!;
  };

  return { users, pedidos, assinaturas, enviados, naRede, comprar, pagar, avisarWebhook, confirmar, planos };
}

async function comConfirmacaoLigada(fn: () => Promise<void>) {
  const antes = process.env.BLACKCAT_CONFIRMACAO_ATIVA;
  process.env.BLACKCAT_CONFIRMACAO_ATIVA = "true";
  try { await fn(); } finally { if (antes === undefined) delete process.env.BLACKCAT_CONFIRMACAO_ATIVA; else process.env.BLACKCAT_CONFIRMACAO_ATIVA = antes; }
}

test("visitante: pedido Cortes → PIX simulado pago → conta criada → Cortes ativo → e-mail simulado → repetição sem duplicar", () => comConfirmacaoLigada(async () => {
  const m = criarMundo();
  const pedido = await m.comprar("  Visitante@Teste.Obaflix.invalid ");
  assert.deepEqual([pedido.userId, pedido.emailComprador, pedido.provedor, pedido.status], [null, "visitante@teste.obaflix.invalid", "simulado", "AGUARDANDO"]);
  assert.match(pedido.transacaoId!, /^sim_[a-f0-9]{24}$/);
  assert.equal("documento" in pedido || JSON.stringify(pedido).includes("52998224725"), false, "CPF não é gravado");

  // Antes do pagamento, o aviso não cria nada.
  await m.avisarWebhook(pedido.transacaoId!, "transaction.created");
  assert.equal(m.users.length, 0);

  assert.equal((await m.pagar(pedido.transacaoId!)).status, 200);
  assert.equal((await m.avisarWebhook(pedido.transacaoId!)).status, 200);

  assert.equal(m.users.length, 1);
  const [conta] = m.users;
  assert.deepEqual([conta.email, conta.senhaHash], ["visitante@teste.obaflix.invalid", null]);
  assert.equal((conta as { dataNascimento?: Date }).dataNascimento?.toISOString(), "1990-05-17T00:00:00.000Z");
  assert.equal(pedido.userId, conta.id);
  assert.equal(pedido.status, "PAGO");
  assert.equal(m.assinaturas.length, 1);
  assert.deepEqual([m.assinaturas[0].userId, m.assinaturas[0].planoId, m.assinaturas[0].status], [conta.id, "cortes-start", "ATIVA"]);

  assert.equal(m.enviados.length, 1);
  assert.equal(m.enviados[0].para, "visitante@teste.obaflix.invalid");
  const token = /#t=([A-Za-z0-9_-]{43})/.exec(m.enviados[0].texto)?.[1];
  assert.ok(token, "link de ativação no e-mail");
  assert.equal(await consumirTokenDeAtivacao(token), conta.id);

  // Mesmo aviso de novo (deduplicado), outro evento PAID e confirmação direta: nada muda.
  await m.avisarWebhook(pedido.transacaoId!);
  await m.avisarWebhook(pedido.transacaoId!, "transaction.created");
  await m.confirmar(pedido.id);
  assert.equal(m.users.length, 1);
  assert.equal(m.assinaturas.length, 1);
  assert.equal(m.enviados.length, 1);
  assert.deepEqual(m.naRede, []);
}));

test("quem já tem assinatura tradicional: Cortes (logado ou pelo e-mail) ativa sem tocar o tradicional", () => comConfirmacaoLigada(async () => {
  const m = criarMundo();
  m.users.push({ id: "u-trad", email: "cliente@teste.obaflix.invalid", senhaHash: "hash-existente" });
  const tradicional = { id: "a-trad", userId: "u-trad", planoId: "basic", status: "ATIVA", terminaEm: new Date(Date.now() + 20 * DIA) };
  m.assinaturas.push(tradicional);
  const fotografia = JSON.stringify(tradicional);

  // Logado.
  const logado = await m.comprar("cliente@teste.obaflix.invalid", "u-trad");
  assert.equal(logado.operacao, "nova");
  await m.pagar(logado.transacaoId!);
  await m.avisarWebhook(logado.transacaoId!);
  assert.equal(logado.status, "PAGO");
  assert.equal(JSON.stringify(tradicional), fotografia);
  assert.equal(m.enviados.length, 0, "compra logada não dispara primeiro acesso");

  // Visitante com o e-mail da mesma conta: vincula, sem criar conta nem trocar senha.
  const m2 = criarMundo();
  m2.users.push({ id: "u-trad", email: "cliente@teste.obaflix.invalid", senhaHash: "hash-existente" });
  const trad2 = { ...tradicional };
  m2.assinaturas.push(trad2);
  const visitante = await m2.comprar("cliente@teste.obaflix.invalid");
  await m2.pagar(visitante.transacaoId!);
  await m2.avisarWebhook(visitante.transacaoId!);
  await m2.confirmar(visitante.id);
  assert.equal(m2.users.length, 1);
  assert.equal(m2.users[0].senhaHash, "hash-existente");
  assert.equal("dataNascimento" in m2.users[0], false, "conta existente não muda");
  assert.equal(visitante.userId, "u-trad");
  assert.equal(JSON.stringify(trad2), fotografia);
  const ativas = m2.assinaturas.filter((a) => a.status === "ATIVA").map((a) => a.planoId).sort();
  assert.deepEqual(ativas, ["basic", "cortes-start"]);
  assert.equal(m2.enviados.length, 1);
  assert.equal(/#t=/.test(m2.enviados[0].texto), false, "conta com senha recebe só orientação");
  assert.ok(m2.enviados[0].texto.includes("https://obaflix.test/login"));
  assert.deepEqual([...m.naRede, ...m2.naRede], []);
}));

// A aprovação manual de compra sem login está coberta em billingRevisao.test.ts.
// Pedido sem conta e sem e-mail de comprador não tem dono possível: recusado antes
// de consultar o provedor ou escrever.
test("aprovação manual de pedido sem conta e sem e-mail é recusada (409 pedido_sem_conta)", async () => {
  let consultou = false;
  const r = await executarAcaoDeRevisao(
    { revisaoId: "rev-1", acao: "ativar", chaveIdempotencia: "chave-operador-a-01", ator: "admin-1" },
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      banco: {
        revisaoPagamentoEvento: { findUnique: async () => null },
        revisaoPagamento: { findUnique: async () => ({ id: "rev-1", status: "PENDENTE", pedidoId: "p", pedido: { userId: null, transacaoId: "sim_x" } }) },
        $transaction: async () => assert.fail("não escreve"),
      } as any,
      consultar: async () => { consultou = true; return { ok: false, falha: "nao_encontrada" } as never; },
    },
  );
  assert.deepEqual(r, { ok: false, status: 409, codigo: "pedido_sem_conta" });
  assert.equal(consultou, false);
});
