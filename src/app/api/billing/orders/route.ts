export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { audit } from "@/lib/auditLog";
import { criarProvedorBlackcat } from "@/lib/billing/blackcat";
import {
  identificadorComercial,
  montarPagador,
  type CorpoDoPagador,
} from "@/lib/billing/pagador";
import { validarOpcoesComerciais, type CorpoDasOpcoes } from "@/lib/billing/opcoes";
import {
  campoFinanceiroNoCorpo,
  cobrancaPixAtiva,
  criarPedidoPix,
  type NovoPedido,
  type RepositorioDePedidos,
} from "@/lib/billing/pedidos";

/**
 * `POST /api/billing/orders` — cria um pedido e o PIX correspondente.
 *
 * **Esta rota não ativa assinatura.** Ela devolve um QR. Nenhuma resposta dela,
 * nenhum retorno do cliente para ela e nenhuma visita a `invoiceUrl` concede
 * direito. A única transição para `PAGO` acontece na confirmação
 * servidor→servidor (`billing/confirmacao.ts`).
 *
 * A rota é fina de propósito: ela cuida do que é HTTP — flag, origem, sessão,
 * IP, limite, tamanho e forma do corpo — e entrega o resto a
 * `criarPedidoPix`, que é onde a regra vive e onde os testes a alcançam sem
 * `NextRequest`, sem banco e sem rede.
 *
 * ## Assinatura vigente
 *
 * Não é mais recusada. O servidor classifica a compra (`vigencia.ts`):
 * renovação do mesmo plano soma ao vencimento; downgrade começa no fim do
 * período pago; upgrade é imediato, com crédito proporcional do que não foi
 * usado, calculado aqui e nunca informado pelo cliente.
 *
 * **Não existe `GET` nesta rota.** O estado do pedido é consultado em
 * `/api/billing/orders/[id]`.
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/** Identificadores, pagador e opções curtas. 2 KB sobra. */
const LIMITE_DO_CORPO = 2048;

// ── Limites ──────────────────────────────────────────────────────────────────
//
// Criar PIX é caro dos dois lados: cada tentativa é uma venda no painel do
// provedor e uma linha aqui. Os números são baixos de propósito — ninguém
// assina cinco vezes por hora de boa-fé, e quem tenta está enumerando ou
// automatizando.
//
// O limite por conta é o que protege o painel do provedor de lixo; o limite por
// IP é o que impede contornar aquele criando contas. Os dois valem sempre.

const LIMITE_POR_CONTA = 5;
const LIMITE_POR_IP = 20;
const JANELA_SEGUNDOS = 3600;

// ── Erros ────────────────────────────────────────────────────────────────────
//
// Corpo curto, código estável, e nada que sirva de oráculo.
//
// `cobranca_indisponivel` é a mesma resposta para: flag desligada, chave de API
// ausente, base inválida e Redis obrigatório fora do ar. **De propósito.**
// Distinguir "a cobrança está desligada" de "falta configuração" diria a quem
// sondar exatamente qual integração existe e o que falta para ela funcionar. O
// detalhe fica no log do servidor, onde é útil e não é público.

function erro(status: number, codigo: string, mensagem: string) {
  return NextResponse.json({ error: mensagem, codigo }, { status, headers: NO_STORE });
}

const INDISPONIVEL = () =>
  erro(503, "cobranca_indisponivel", "Pagamento temporariamente indisponível");

/** Mensagens das recusas de composição da compra. Códigos estáveis, sem detalhe interno. */
const MENSAGEM_DA_RECUSA: Record<string, string> = {
  duracao_invalida: "Duração indisponível",
  telas_acima_do_limite: "Limite de telas adicionais excedido",
  adicional_indisponivel: "Adicional indisponível",
  servidor_vip_ja_incluso: "O servidor VIP já está incluso neste plano",
  credito_maior_que_compra: "Escolha uma duração que cubra o crédito do seu plano atual",
  parametros_invalidos: "Parâmetros inválidos",
};

// ── Corpo ────────────────────────────────────────────────────────────────────

/**
 * O corpo aceito: dois identificadores comerciais, os dados do pagador que a
 * Blackcat exige e o nosso banco não tem, e as opções (cupom, telas extras, VIP
 * avulso). Nenhum campo de valor.
 */
interface Corpo extends CorpoDoPagador, CorpoDasOpcoes {
  planoId?: unknown;
  planoPrecoId?: unknown;
}

// ── Repositório ──────────────────────────────────────────────────────────────

/**
 * A porta do banco, sobre o Prisma.
 *
 * Fica aqui, e não em `pedidos.ts`, para o serviço permanecer sem import de
 * Prisma — é o que permite os testes exercitarem todos os caminhos sem
 * `DATABASE_URL`.
 */
const repositorio: RepositorioDePedidos = {
  async buscarPreco(planoPrecoId) {
    return prisma.planoPreco.findUnique({
      where: { id: planoPrecoId },
      select: {
        id: true,
        planoId: true,
        rotulo: true,
        precoCentavos: true,
        duracaoDias: true,
        duracaoMeses: true,
        moeda: true,
        ativo: true,
        plano: { select: { id: true, nome: true, ativo: true, ordem: true, servidorVip: true } },
      },
    });
  },

  async buscarAdicionais(planoId) {
    const linhas = await prisma.planoAdicionalPreco.findMany({
      where: { planoId, ativo: true, moeda: "BRL" },
      select: { tipo: true, precoMensalCentavos: true },
    });
    return {
      telaMensalCentavos: linhas.find((l) => l.tipo === "tela")?.precoMensalCentavos ?? null,
      servidorVipMensalCentavos: linhas.find((l) => l.tipo === "servidor_vip")?.precoMensalCentavos ?? null,
    };
  },

  async periodosEmAberto(userId, agora) {
    const linhas = await prisma.assinatura.findMany({
      where: { userId, status: "ATIVA", terminaEm: { gt: agora } },
      select: {
        id: true, planoId: true, iniciaEm: true, terminaEm: true,
        plano: { select: { ordem: true } },
        pedido: { select: { valorCentavos: true } },
      },
    });
    // Período sem pedido (cortesia, admin) não gera crédito: não houve pagamento.
    return linhas.map((l) => ({
      id: l.id,
      planoId: l.planoId,
      ordemDoPlano: l.plano.ordem,
      iniciaEm: l.iniciaEm,
      terminaEm: l.terminaEm,
      valorPagoCentavos: l.pedido?.valorCentavos ?? 0,
    }));
  },

  async criar(dados: NovoPedido) {
    const { descricao: _descricao, iniciaEmPrevisto: _inicio, ...colunas } = dados;
    // `descricao` e `iniciaEmPrevisto` ficam em memória: um vai para a fatura do
    // provedor, o outro para a resposta. O início real é decidido na confirmação.
    return prisma.pedidoPagamento.create({
      data: colunas,
      select: { id: true },
    });
  },

  async registrarVenda(pedidoId, { transacaoId, expiraEm }) {
    await prisma.pedidoPagamento.update({
      where: { id: pedidoId },
      data: { status: "AGUARDANDO", transacaoId, expiraEm },
    });
  },

  async registrarFalha(pedidoId, { status, transacaoId }) {
    await prisma.pedidoPagamento.update({
      where: { id: pedidoId },
      data: transacaoId ? { status, transacaoId } : { status },
    });
  },
};

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 1. A flag, antes de tudo. Desligada: nenhuma consulta, nenhum pedido,
  //    nenhuma chamada externa, e a mesma resposta genérica de qualquer outra
  //    indisponibilidade.
  if (!cobrancaPixAtiva()) return INDISPONIVEL();

  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") || "unknown";

  // 2. Origem. Mesmo critério de `/api/player/fontes`: só confere quando o
  //    `Origin` existe, que é o caso do navegador — é ele que envia cookie
  //    automaticamente, e é por isso que uma mutação por cookie precisa desta
  //    checagem. Cliente nativo com Bearer não manda `Origin` e não é afetado.
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && !headerMatchesHost(origin, host)) {
    audit("origin_rejected", { ip, ua, detail: "/billing/orders" });
    return erro(403, "acesso_negado", "Acesso negado");
  }

  // 3. Sessão. Cookie (site, Electron, app) ou Bearer de TV — o mesmo ponto
  //    único de autorização do resto do projeto.
  const usuario = await getUserFromRequest(req);
  if (!usuario) {
    audit("auth_failure", { ip, ua, detail: "/billing/orders sem sessão" });
    return erro(401, "acesso_negado", "Acesso negado");
  }
  const userId = usuario.userId;

  // 4. Limites. Os dois sempre, e nesta ordem: a conta é o sujeito da cobrança,
  //    o IP é o que impede contornar o limite da conta criando contas.
  //
  //    **Dinheiro não falha aberto**: o `catch` recusa, em vez de deixar passar.
  try {
    const [porConta, porIp] = await Promise.all([
      checkRateLimit(`billing:orders:user:${userId}`, LIMITE_POR_CONTA, JANELA_SEGUNDOS),
      checkRateLimit(`billing:orders:ip:${ip}`, LIMITE_POR_IP, JANELA_SEGUNDOS),
    ]);
    if (!porConta.allowed || !porIp.allowed) {
      audit("rate_limited", { userId, ip, ua, detail: "/billing/orders" });
      return erro(429, "muitas_tentativas", "Muitas tentativas. Tente mais tarde");
    }
  } catch {
    audit("billing_order_failed", { userId, ip, ua, detail: "limite indisponivel" });
    return INDISPONIVEL();
  }

  // 5. Corpo, com teto pequeno.
  let corpo: Corpo;
  try {
    corpo = await readJsonBody<Corpo>(req, LIMITE_DO_CORPO);
  } catch {
    return erro(400, "parametros_invalidos", "Parâmetros inválidos");
  }
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
    return erro(400, "parametros_invalidos", "Parâmetros inválidos");
  }

  // 6. A fronteira de confiança, explícita. Valor, total, crédito ou preço no
  //    corpo são recusados — o servidor calcula tudo.
  const proibido = campoFinanceiroNoCorpo(corpo as Record<string, unknown>);
  if (proibido) {
    return erro(400, "campo_nao_permitido", "Parâmetros inválidos");
  }

  // 7. Opções: cupom (indisponível), telas extras e VIP avulso (formato). O
  //    código vai para o log; o valor do cupom, não.
  const opcoes = validarOpcoesComerciais(corpo as CorpoDasOpcoes);
  if (!opcoes.ok) {
    audit("billing_order_failed", { userId, ip, ua, detail: `opcoes: ${opcoes.codigo}` });
    const mensagem = opcoes.codigo === "cupom_invalido"
      ? "Cupom inválido"
      : opcoes.codigo === "adicional_indisponivel"
        ? "Adicional indisponível"
        : "Parâmetros inválidos";
    return erro(opcoes.codigo === "parametros_invalidos" ? 400 : 422, opcoes.codigo, mensagem);
  }

  const planoId = identificadorComercial(corpo.planoId);
  const planoPrecoId = identificadorComercial(corpo.planoPrecoId);
  if (!planoId || !planoPrecoId) {
    return erro(400, "parametros_invalidos", "Parâmetros inválidos");
  }

  const conta = await prisma.user.findUnique({
    where: { id: userId },
    select: { nome: true, email: true },
  });
  if (!conta) {
    return erro(401, "acesso_negado", "Acesso negado");
  }

  const pagador = montarPagador(conta, corpo);
  if (!pagador) {
    return erro(400, "dados_do_pagador_invalidos", "Dados de pagamento inválidos");
  }

  // O provedor é montado ANTES de qualquer escrita: sem chave de API, a resposta
  // é 503 e **nenhum pedido é criado**.
  const provedor = criarProvedorBlackcat();
  if (!provedor) {
    audit("billing_order_failed", { userId, ip, ua, detail: "provedor nao configurado" });
    return INDISPONIVEL();
  }

  // 8. Preço, adicionais, operação e crédito do banco; snapshot; pedido CRIADO;
  //    chamada; conferência de valor; AGUARDANDO. Tudo em `criarPedidoPix`.
  let resultado;
  try {
    resultado = await criarPedidoPix(
      {
        userId, planoId, planoPrecoId, pagador,
        telasAdicionais: opcoes.telasAdicionais,
        servidorVip: opcoes.servidorVip,
      },
      { repo: repositorio, provedor },
    );
  } catch {
    audit("billing_order_failed", { userId, ip, ua, detail: "erro interno" });
    return INDISPONIVEL();
  }

  if (resultado.situacao === "nao_compravel") {
    audit("billing_order_failed", { userId, ip, ua, detail: `nao compravel: ${resultado.motivo}` });
    return erro(422, "plano_indisponivel", "Plano indisponível para compra");
  }

  if (resultado.situacao === "compra_recusada") {
    audit("billing_order_failed", { userId, ip, ua, detail: `compra recusada: ${resultado.codigo}` });
    return erro(422, resultado.codigo, MENSAGEM_DA_RECUSA[resultado.codigo] ?? "Parâmetros inválidos");
  }

  if (resultado.situacao === "revisao_manual") {
    audit("billing_order_failed", {
      userId, ip, ua,
      detail: `revisao manual (${resultado.motivo}): pedido ${resultado.pedidoId}`,
    });
    return erro(502, "pagamento_indisponivel", "Não foi possível gerar o pagamento");
  }

  if (resultado.situacao === "falha_no_provedor") {
    audit("billing_order_failed", {
      userId, ip, ua,
      detail: `provedor ${resultado.falha}: pedido ${resultado.pedidoId}`,
    });
    return erro(502, "pagamento_indisponivel", "Não foi possível gerar o pagamento");
  }

  audit("billing_order_created", {
    userId, ip, ua,
    detail: `pedido ${resultado.pedidoId} operacao:${resultado.operacao}`,
  });

  // 9. A resposta, no nosso contrato. O QR e o copia-e-cola não são persistidos
  //    nem logados. `operacao`, `creditoCentavos` e `iniciaEm` explicam o valor;
  //    o início definitivo é recalculado na confirmação.
  return NextResponse.json(
    {
      pedidoId: resultado.pedidoId,
      status: resultado.status,
      valorCentavos: resultado.valorCentavos,
      moeda: resultado.moeda,
      expiraEm: resultado.expiraEm.toISOString(),
      operacao: resultado.operacao,
      creditoCentavos: resultado.creditoCentavos,
      iniciaEm: resultado.iniciaEmPrevisto.toISOString(),
      pix: {
        qrCode: resultado.pix.qrCode,
        qrCodeBase64: resultado.pix.qrCodeBase64,
        copiaECola: resultado.pix.copiaECola,
      },
    },
    { status: 201, headers: NO_STORE },
  );
}
