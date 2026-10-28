export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authSession";
import { ehClientePlay, CODIGO_COMPRAS_INDISPONIVEIS_PLAY } from "@/config/play";
import { prisma } from "@/lib/prisma";
import { ehPlanoCortes, ordemNaFamilia } from "@/lib/planos";
import { checkRateLimit, clientIp, headerMatchesHost, readJsonBody } from "@/lib/requestSecurity";
import { audit } from "@/lib/auditLog";
import { provedorDeCobranca } from "@/lib/billing/simulado";
import { caktoPixAtivo, pilotoCaktoAutorizado } from "@/lib/billing/cakto";
import {
  emailDoComprador,
  nascimentoDoComprador,
  identificadorComercial,
  montarPagador,
  type CorpoDoPagador,
} from "@/lib/billing/pagador";
import { validarOpcoesComerciais, type CorpoDasOpcoes } from "@/lib/billing/opcoes";
import { abrirRevisao, travarContaParaCobranca, MENSAGEM_DE_REVISAO_AO_COMPRADOR } from "@/lib/billing/revisao";
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
  valor_fora_da_oferta: "Upgrade com crédito ainda não está disponível neste pagamento. Aguarde o fim do plano atual ou fale com o suporte.",
  parametros_invalidos: "Parâmetros inválidos",
};

// ── Corpo ────────────────────────────────────────────────────────────────────

/**
 * O corpo aceito: dois identificadores comerciais, os dados do pagador que a
 * Blackcat exige e o nosso banco não tem, e as opções (cupom, telas extras, VIP
 * avulso). Nenhum campo de valor.
 */
interface Corpo extends CorpoDoPagador, CorpoDasOpcoes {
  /** Só sem sessão (compra Cortes sem login). Com sessão, vale o e-mail da conta. */
  email?: unknown;
  /** Só sem sessão: `AAAA-MM-DD`, para o cadastro que nasce na confirmação. */
  nascimento?: unknown;
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
        plano: { select: { id: true, nome: true, ativo: true, ordem: true, servidorVip: true, cortesNivel: true } },
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
        plano: { select: { ordem: true, cortesNivel: true } },
        pedido: { select: { valorCentavos: true } },
      },
    });
    // Período sem pedido (cortesia, admin) não gera crédito: não houve pagamento.
    return linhas.map((l) => ({
      id: l.id,
      planoId: l.planoId,
      ordemDoPlano: ordemNaFamilia(l.plano.ordem, l.plano.cortesNivel),
      cortes: ehPlanoCortes(l.plano.cortesNivel),
      iniciaEm: l.iniciaEm,
      terminaEm: l.terminaEm,
      valorPagoCentavos: l.pedido?.valorCentavos ?? 0,
    }));
  },

  async revisaoPendente(userId) {
    const caso = await prisma.revisaoPagamento.findFirst({
      where: { userId, status: "PENDENTE" },
      select: { id: true },
    });
    return caso !== null;
  },

  async criar(dados: NovoPedido) {
    const { descricao: _descricao, iniciaEmPrevisto: _inicio, ...colunas } = dados;
    // `descricao` e `iniciaEmPrevisto` ficam em memória: um vai para a fatura do
    // provedor, o outro para a resposta. O início real é decidido na confirmação.
    //
    // Conta travada durante a checagem e a gravação. Quem abre revisão usa a
    // mesma trava; com requisições simultâneas, uma espera a outra e a checagem
    // enxerga o caso que acabou de ser gravado.
    // Compra sem login não tem conta a travar nem revisão de conta a conferir.
    if (!colunas.userId) return prisma.pedidoPagamento.create({ data: colunas, select: { id: true } });
    const userId = colunas.userId;
    return prisma.$transaction(async (tx) => {
      await travarContaParaCobranca(tx, userId);
      const pendente = await tx.revisaoPagamento.findFirst({
        where: { userId, status: "PENDENTE" },
        select: { id: true },
      });
      if (pendente) return null;
      return tx.pedidoPagamento.create({ data: colunas, select: { id: true } });
    });
  },

  async registrarVenda(pedidoId, { transacaoId, expiraEm }) {
    await prisma.pedidoPagamento.update({
      where: { id: pedidoId },
      data: { status: "AGUARDANDO", transacaoId, expiraEm },
    });
  },

  async registrarFalha(pedidoId, { status, transacaoId, expiraEm, motivo }) {
    // `expiraEm` só é gravado quando o provedor deu um prazo válido: preserva a
    // informação necessária para reconciliar a revisão sem conceder direito.
    const data = {
      status,
      ...(transacaoId ? { transacaoId } : {}),
      ...(expiraEm ? { expiraEm } : {}),
    };
    if (status !== "REVISAO_MANUAL") {
      await prisma.pedidoPagamento.update({ where: { id: pedidoId }, data });
      return;
    }
    // Pedido em revisão e caso aberto juntos: nunca um sem o outro.
    await prisma.$transaction(async (tx) => {
      const pedido = await tx.pedidoPagamento.update({ where: { id: pedidoId }, data, select: { userId: true } });
      await abrirRevisao(tx, { pedidoId, userId: pedido.userId, motivo: motivo ?? "criacao_falha_com_transacao" });
    });
  },
};

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 0. Distribuição Google Play: consumo apenas, antes de qualquer outra coisa.
  //    O app da Play (User-Agent `ObaflixPlay/`) não pode comprar — a loja
  //    proíbe pagamento fora do seu sistema. Recusa AQUI, antes da flag, da
  //    origem, da sessão, do banco e do provedor: nenhum PedidoPagamento e
  //    nenhum PIX são criados para o cliente Play. Código estável para o cliente
  //    ramificar; só RESTRINGE quem envia `ObaflixPlay/` — navegador, APK
  //    direto, Electron e TV não enviam e seguem comprando como sempre.
  if (ehClientePlay(req.headers.get("user-agent"))) {
    return erro(403, CODIGO_COMPRAS_INDISPONIVEIS_PLAY, "Compras não estão disponíveis neste aplicativo");
  }

  // 1. A flag, antes de tudo. Desligada: nenhuma consulta, nenhum pedido,
  //    nenhuma chamada externa, e a mesma resposta genérica de qualquer outra
  //    indisponibilidade.
  if (!cobrancaPixAtiva() && !caktoPixAtivo()) return INDISPONIVEL();

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
  //    único de autorização do resto do projeto. Sem sessão, segue só a compra
  //    Cortes por e-mail: a conta nasce na confirmação autenticada do pagamento.
  const usuario = await getUserFromRequest(req);
  const userId = usuario?.userId ?? null;

  // 4. Limites. Os dois sempre, e nesta ordem: a conta é o sujeito da cobrança,
  //    o IP é o que impede contornar o limite da conta criando contas. Sem
  //    conta, o limite por e-mail vem depois do corpo.
  //
  //    **Dinheiro não falha aberto**: o `catch` recusa, em vez de deixar passar.
  try {
    const [porConta, porIp] = await Promise.all([
      userId ? checkRateLimit(`billing:orders:user:${userId}`, LIMITE_POR_CONTA, JANELA_SEGUNDOS) : { allowed: true },
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

  // Piloto privado: segredo e regra de liberacao vivem em billing/cakto.ts.
  if (caktoPixAtivo() && ehPlanoCortes(planoId)
    && !pilotoCaktoAutorizado(planoId, req.headers.get("x-obaflix-cakto-piloto"))) {
    return INDISPONIVEL();
  }

  const conta = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { nome: true, email: true } })
    : (() => { const email = emailDoComprador(corpo.email); return email ? { nome: null, email } : null; })();
  if (!conta) {
    if (!userId) audit("auth_failure", { ip, ua, detail: "/billing/orders sem sessão" });
    return erro(401, "acesso_negado", "Acesso negado");
  }
  // Compra sem login: a data de nascimento vai para o cadastro que nasce na confirmação.
  const nascimento = userId ? null : nascimentoDoComprador(corpo.nascimento);
  if (!userId && !nascimento) return erro(400, "nascimento_invalido", "Data de nascimento inválida");

  if (!userId) {
    // Sem conta, o e-mail é o sujeito: impede usar a rota para encher a caixa
    // de alguém com cobranças.
    try {
      const porEmail = await checkRateLimit(`billing:orders:email:${conta.email}`, LIMITE_POR_CONTA, JANELA_SEGUNDOS);
      if (!porEmail.allowed) {
        audit("rate_limited", { ip, ua, detail: "/billing/orders email" });
        return erro(429, "muitas_tentativas", "Muitas tentativas. Tente mais tarde");
      }
    } catch {
      return INDISPONIVEL();
    }
  }

  const pagador = montarPagador(conta, corpo);
  if (!pagador) {
    return erro(400, "dados_do_pagador_invalidos", "Dados de pagamento inválidos");
  }

  // O provedor é montado ANTES de qualquer escrita: sem chave de API, a resposta
  // é 503 e **nenhum pedido é criado**.
  // Blackcat, ou a simulação — só com as três condições do ambiente isolado.
  const { provedor, nome: nomeDoProvedor } = provedorDeCobranca(undefined, planoId);
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
        ...(userId ? {} : { comprador: { email: conta.email, nome: pagador.nome, nascimento } }),
        telasAdicionais: opcoes.telasAdicionais,
        servidorVip: opcoes.servidorVip,
      },
      { repo: repositorio, provedor, nomeDoProvedor },
    );
  } catch {
    audit("billing_order_failed", { userId, ip, ua, detail: "erro interno" });
    return INDISPONIVEL();
  }

  if (resultado.situacao === "nao_compravel") {
    audit("billing_order_failed", { userId, ip, ua, detail: `nao compravel: ${resultado.motivo}` });
    return erro(422, "plano_indisponivel", "Plano indisponível para compra");
  }

  // Mesma resposta de "sem sessão": não diz nada sobre o plano nem o e-mail.
  if (resultado.situacao === "exige_login") {
    audit("auth_failure", { ip, ua, detail: "/billing/orders sem sessão" });
    return erro(401, "acesso_negado", "Acesso negado");
  }

  if (resultado.situacao === "revisao_pendente") {
    audit("billing_order_blocked_review", { userId, ip, ua, detail: "/billing/orders" });
    return erro(409, "pagamento_em_revisao", MENSAGEM_DE_REVISAO_AO_COMPRADOR);
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
