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
 * servidor→servidor da Fase 5, que ainda não existe.
 *
 * A rota é fina de propósito: ela cuida do que é HTTP — flag, origem, sessão,
 * IP, limite, tamanho e forma do corpo — e entrega o resto a
 * `criarPedidoPix`, que é onde a regra vive e onde os testes a alcançam sem
 * `NextRequest`, sem banco e sem rede.
 *
 * **Não existe `GET` nesta fase.** Consultar estado de pedido é polling, e
 * polling pertence à fase que tem o que consultar.
 */

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate, private" };

/** Um corpo de dois identificadores e três campos curtos. 2 KB sobra. */
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

// ── Corpo ────────────────────────────────────────────────────────────────────

/**
 * O corpo aceito: dois identificadores comerciais e os dados do pagador que a
 * Blackcat exige e o nosso banco não tem.
 *
 * A validação de cada campo vive em `@/lib/billing/pagador` — um módulo de rota
 * só pode exportar os verbos HTTP, então funções deixadas aqui seriam
 * inalcançáveis pelos testes.
 */
interface Corpo extends CorpoDoPagador {
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
 *
 * `select` explícito em `buscarPreco`: a consulta traz o que decide a compra e
 * nada mais.
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
        moeda: true,
        ativo: true,
        plano: { select: { id: true, nome: true, ativo: true } },
      },
    });
  },

  async criar(dados: NovoPedido) {
    const { descricao: _descricao, ...colunas } = dados;
    // `descricao` é do snapshot em memória, para a fatura do provedor. Não vira
    // coluna: repetir o nome comercial do plano numa linha por tentativa de
    // compra não responde nenhuma pergunta que `planoId` já não responda.
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

  // 5. Limites. Os dois sempre, e nesta ordem: a conta é o sujeito da cobrança,
  //    o IP é o que impede contornar o limite da conta criando contas.
  //
  //    `checkRateLimit` resolve o Redis por dentro, e em produção sem Upstash
  //    `getRedis()` lança. **Dinheiro não falha aberto**: o `catch` recusa, em
  //    vez de deixar passar. Um limite que some quando o Redis some não é
  //    limite, e aqui cada passagem é uma venda no painel do provedor.
  try {
    const [porConta, porIp] = await Promise.all([
      checkRateLimit(`billing:orders:user:${userId}`, LIMITE_POR_CONTA, JANELA_SEGUNDOS),
      checkRateLimit(`billing:orders:ip:${ip}`, LIMITE_POR_IP, JANELA_SEGUNDOS),
    ]);
    if (!porConta.allowed || !porIp.allowed) {
      audit("rate_limited", { userId, ip, ua, detail: "/billing/orders" });
      // Sem contador, sem `Retry-After` calculado a partir do estado interno e
      // sem dizer qual dos dois limites bateu — nada que ajude a calibrar uma
      // tentativa seguinte.
      return erro(429, "muitas_tentativas", "Muitas tentativas. Tente mais tarde");
    }
  } catch {
    audit("billing_order_failed", { userId, ip, ua, detail: "limite indisponivel" });
    return INDISPONIVEL();
  }

  // 6. Corpo, com teto pequeno.
  let corpo: Corpo;
  try {
    corpo = await readJsonBody<Corpo>(req, LIMITE_DO_CORPO);
  } catch {
    return erro(400, "parametros_invalidos", "Parâmetros inválidos");
  }
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) {
    return erro(400, "parametros_invalidos", "Parâmetros inválidos");
  }

  // 7. A fronteira de confiança, explícita. Nenhum destes campos influenciaria
  //    a cobrança de qualquer forma — o valor sai do banco. Recusar em vez de
  //    ignorar existe para a fronteira ficar inequívoca: quem manda `amount`
  //    está errado sobre como esta API funciona, e um 201 cobrando outro valor
  //    deixaria a dúvida de pé.
  const proibido = campoFinanceiroNoCorpo(corpo as Record<string, unknown>);
  if (proibido) {
    return erro(400, "campo_nao_permitido", "Parâmetros inválidos");
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
    // Sessão válida para uma conta que não existe mais. Não é 401 (o token está
    // bom) e não é 500 (nada quebrou) — é um pedido que não pode ser atendido.
    return erro(401, "acesso_negado", "Acesso negado");
  }

  const pagador = montarPagador(conta, corpo);
  if (!pagador) {
    return erro(400, "dados_do_pagador_invalidos", "Dados de pagamento inválidos");
  }

  // O provedor é montado ANTES de qualquer escrita: sem chave de API, a resposta
  // é 503 e **nenhum pedido é criado**. Falha de configuração nossa não pode
  // deixar linha de cobrança pendurada no banco.
  const provedor = criarProvedorBlackcat();
  if (!provedor) {
    audit("billing_order_failed", { userId, ip, ua, detail: "provedor nao configurado" });
    return INDISPONIVEL();
  }

  // 8–13. Preço do banco, snapshot, pedido CRIADO, chamada, conferência de valor
  //       e AGUARDANDO. Tudo em `criarPedidoPix`.
  let resultado;
  try {
    resultado = await criarPedidoPix({ userId, planoId, planoPrecoId, pagador }, {
      repo: repositorio,
      provedor,
    });
  } catch {
    // Banco fora, ou a gravação do `transacaoId` falhou depois de a venda existir
    // no provedor. Nenhum detalhe sai daqui — nem mensagem, nem stack, nem SQL.
    audit("billing_order_failed", { userId, ip, ua, detail: "erro interno" });
    return INDISPONIVEL();
  }

  if (resultado.situacao === "nao_compravel") {
    // 422 e não 404: os identificadores podem existir perfeitamente — o que não
    // existe é a possibilidade de comprá-los agora. O motivo interno vai para o
    // log; o cliente recebe um código só, para não conseguir sondar quais
    // preços estão ativos.
    audit("billing_order_failed", { userId, ip, ua, detail: `nao compravel: ${resultado.motivo}` });
    return erro(422, "plano_indisponivel", "Plano indisponível para compra");
  }

  if (resultado.situacao === "revisao_manual") {
    // Existe uma venda no provedor que não podemos usar: valor diferente do
    // combinado, estado que não é `PENDING`, ou já vencida. Não entregamos o PIX
    // como sucesso e nada é ativado. Para o cliente é indistinguível de uma
    // falha de gateway — e é assim que deve ser.
    //
    // O `motivo` é um código do conjunto fechado de `MotivoDeRevisao`, nunca
    // texto do provedor.
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
    detail: `pedido ${resultado.pedidoId}`,
  });

  // 14. A resposta, no nosso contrato.
  //
  // O QR e o copia-e-cola vão aqui — resposta autenticada, `no-store`, para quem
  // acabou de criar o pedido. **Não são persistidos e não são logados**: guardar
  // o copia-e-cola transformaria um vazamento de backup em meio de pagamento
  // utilizável.
  //
  // Fora daqui, de propósito: `transactionId` (o cliente trabalha com o nosso
  // `pedidoId`), `netAmount`, `fees`, `invoiceUrl`, `refExterna`, nome do
  // provedor e qualquer parte do payload da Blackcat.
  return NextResponse.json(
    {
      pedidoId: resultado.pedidoId,
      status: resultado.status,
      valorCentavos: resultado.valorCentavos,
      moeda: resultado.moeda,
      expiraEm: resultado.expiraEm.toISOString(),
      pix: {
        qrCode: resultado.pix.qrCode,
        qrCodeBase64: resultado.pix.qrCodeBase64,
        copiaECola: resultado.pix.copiaECola,
      },
    },
    { status: 201, headers: NO_STORE },
  );
}
