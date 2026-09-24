/**
 * Pedidos de pagamento — domínio e serviço de criação de PIX.
 *
 * Responde uma pergunta só: **esta conta pode abrir uma cobrança para este
 * preço, e qual PIX o provedor devolveu?** Nada aqui concede direito.
 *
 * ## A regra que dá nome a esta fase
 *
 * **Um pedido não é uma assinatura.** Um PIX criado, um `transactionId`, um QR
 * lido, uma tela visitada e até um `status: "PAID"` vindo na resposta de criação
 * **não ativam nada**. Não existe neste arquivo — nem em nenhum outro desta
 * fase — caminho que escreva `PAGO` ou insira em `Assinatura`. A confirmação
 * servidor→servidor, o webhook e a reconciliação são a Fase 5.
 *
 * Por isso `PAGO` está no domínio — o CHECK do banco precisa dele — mas
 * `criarPedidoPix` não o escreve em nenhum ramo. `STATUS_DA_FASE_4` declara
 * quais estados esta fase é capaz de escrever, e
 * `src/lib/__tests__/billingPedidos.test.ts` exercita todos os caminhos contra
 * um repositório que registra cada gravação: a promessa é verificada, não só
 * afirmada.
 *
 * ## Onde este módulo para
 *
 *   - decide se um preço é comprável e congela o snapshot → **sim**
 *   - fala HTTP com a Blackcat → **não**, isso é de `./blackcat.ts`, que
 *     implementa a porta `ProvedorPix` daqui
 *   - lê `NextRequest`, cookie, origem ou rate limit → **não**, isso é da rota
 *   - toca `Assinatura` ou `invalidarEntitlements` → **nunca**
 *
 * O provedor e o repositório entram como portas injetadas. Em produção são a
 * Blackcat e o Prisma; nos testes são objetos em memória — nenhum teste desta
 * fase abre conexão de rede ou de banco.
 */

import { randomBytes } from "node:crypto";

import { calcularTotal, type PrecosDosAdicionais } from "./precificacao";
import { classificarOperacao, valorNaoUtilizado, type Duracao, type PeriodoPago } from "./vigencia";
import { SERVIDOR_VIP_AVULSO_OFERTADO, nomePublicoDoPlano } from "./vitrine";
import type { MotivoDeRevisao as CodigoDeRevisao } from "./revisao";

// ── Domínio ──────────────────────────────────────────────────────────────────

/**
 * A máquina de estados do pagamento, inteira.
 *
 * Espelho exato do CHECK de `prisma/migrations/20260910_pedido_pagamento`.
 * `src/lib/__tests__/pedidoPagamento.test.ts` lê os dois arquivos e falha se
 * divergirem — mesmo mecanismo que `planos.ts` usa para os domínios da Fase 1.
 *
 * A Fase 4 escreve quatro destes: `CRIADO`, `AGUARDANDO`, `FALHOU` e
 * `REVISAO_MANUAL`. Os outros cinco existem para a Fase 5 não precisar de uma
 * migration de domínio no meio do fluxo de pagamento.
 */
export const STATUS_PEDIDO = [
  "CRIADO",
  "AGUARDANDO",
  "CONFIRMANDO",
  "PAGO",
  "EXPIRADO",
  "CANCELADO",
  "FALHOU",
  "ESTORNADO",
  "REVISAO_MANUAL",
] as const;

export type StatusPedido = (typeof STATUS_PEDIDO)[number];

/**
 * Os estados que esta fase é capaz de escrever.
 *
 * `PAGO` não está aqui, e a ausência é o ponto: o teste do serviço percorre
 * todos os caminhos de `criarPedidoPix` e falha se qualquer gravação sair deste
 * conjunto.
 */
export const STATUS_DA_FASE_4 = ["CRIADO", "AGUARDANDO", "FALHOU", "REVISAO_MANUAL"] as const;

/**
 * `simulado` só existe no ambiente isolado de testes (`simulado.ts`). O CHECK de
 * Production aceita apenas `blackcat`: um pedido simulado não grava lá nem com a
 * configuração errada.
 */
export const PROVEDORES_PAGAMENTO = ["blackcat", "simulado"] as const;
export type ProvedorPagamento = (typeof PROVEDORES_PAGAMENTO)[number];

/**
 * As moedas que a integração aceita.
 *
 * Não é decoração: a Blackcat cobra em centavos de uma moeda só hoje, e um
 * `PlanoPreco` cadastrado em outra moeda geraria uma cobrança com o número certo
 * e a unidade errada. O preço é recusado antes de virar pedido.
 */
export const MOEDAS_SUPORTADAS = ["BRL"] as const;

// ── Feature flag ─────────────────────────────────────────────────────────────

/**
 * O interruptor da cobrança, lido do ambiente do servidor.
 *
 * **Só a string exata `"true"` liga.** `undefined`, `""`, `"false"`, `"0"`,
 * `"1"` e `"TRUE"` deixam desligado — mesmo critério (e mesmo motivo) de
 * `monetizacaoAtiva` em `playbackAuthorization.ts`:
 * `Boolean(process.env.BLACKCAT_PIX_ATIVO)` faria `BLACKCAT_PIX_ATIVO=false`
 * **ligar** a cobrança, porque `Boolean("false")` é `true`.
 *
 * **Separada de `MONETIZACAO_ATIVA` de propósito.** Aquela decide se o
 * enforcement comercial nega conteúdo; esta decide se é possível cobrar. São
 * interruptores de coisas diferentes e precisam poder ser acionados em
 * separado: cobrar antes de restringir é o rollout normal, e desligar a cobrança
 * durante um incidente do gateway não pode derrubar o acesso de quem já pagou.
 *
 * Não existe `NEXT_PUBLIC_` desta variável, e não deve passar a existir.
 *
 * O parâmetro `env` existe para os testes lerem um objeto próprio em vez de
 * mexerem no ambiente do processo.
 */
export function cobrancaPixAtiva(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.BLACKCAT_PIX_ATIVO === "true";
}

// ── refExterna ───────────────────────────────────────────────────────────────

/** 16 bytes = 128 bits, em hexadecimal. */
export const BYTES_DA_REF_EXTERNA = 16;

/**
 * Nossa referência da venda, gerada **no servidor**.
 *
 * 128 bits de aleatoriedade criptográfica, e nada derivado de `userId`,
 * `pedidoId`, e-mail, sequência ou relógio. Um identificador previsível aqui
 * permitiria enumerar pedidos de outras contas e correlacionar compras — e
 * `refExterna` viaja para fora, no `externalRef` da Blackcat.
 *
 * É também o que liga uma venda criada no provedor a um pedido nosso quando a
 * resposta HTTP se perde. Ver a nota sobre risco residual em `criarPedidoPix`.
 */
export function gerarRefExterna(
  aleatorio: (n: number) => Buffer = randomBytes,
): string {
  return aleatorio(BYTES_DA_REF_EXTERNA).toString("hex");
}

// ── Resolução do preço ───────────────────────────────────────────────────────

/** O que o banco precisa devolver para decidir se um preço é comprável. */
export interface PrecoDoBanco {
  id: string;
  planoId: string;
  rotulo: string;
  precoCentavos: number;
  /** Exatamente um dos dois, garantido por CHECK. */
  duracaoDias: number | null;
  duracaoMeses?: number | null;
  moeda: string;
  ativo: boolean;
  /** `null` quando a linha veio sem o plano relacionado. */
  plano: { id: string; nome: string; ativo: boolean; ordem?: number; servidorVip?: boolean } | null;
}

/**
 * Por que este preço não gera cobrança.
 *
 * Todos viram a mesma resposta HTTP para o cliente. A distinção existe para o
 * log do servidor e para os testes — devolver ao cliente qual das sete falhou
 * lhe daria um oráculo sobre o catálogo comercial.
 */
export type MotivoNaoCompravel =
  | "preco_inexistente"
  | "preco_inativo"
  | "plano_ausente"
  | "plano_inativo"
  | "plano_divergente"
  | "valor_invalido"
  | "duracao_invalida"
  | "moeda_nao_suportada";

/**
 * O que o pedido congela no instante da compra.
 *
 * `valorCentavos` e `duracaoDias` são cópias, não referências. Se `PlanoPreco`
 * mudar depois que o PIX foi criado, o pedido continua sabendo quanto custava e
 * qual duração estava sendo comprada — que é a única forma de a Fase 5 conferir
 * o valor pago sem depender do preço atual da tabela.
 */
export interface SnapshotDeCompra {
  planoId: string;
  planoPrecoId: string;
  valorCentavos: number;
  moeda: string;
  /** Exatamente um dos dois: dias, ou meses de calendário. */
  duracaoDias: number | null;
  duracaoMeses: number | null;
  /** Só para a descrição do item na fatura do provedor. Não autoriza nada. */
  descricao: string;
}

export type ResolucaoDePreco =
  | { compravel: true; snapshot: SnapshotDeCompra }
  | { compravel: false; motivo: MotivoNaoCompravel };

/**
 * Este preço pode virar cobrança? Função total e pura.
 *
 * **Nenhuma ramificação por nome ou id de plano.** Não existe aqui `if (nome ===
 * "Premium")` nem `if (planoId === "gratuito")`, e não deve passar a existir: o
 * que decide são as colunas — `ativo`, `precoCentavos`, `duracaoDias`, `moeda`.
 *
 * `planoIdPedido` é o que o cliente declarou. Ele **não** escolhe o preço: serve
 * só para recusar um par (plano, preço) incoerente, que é sintoma de cliente
 * desatualizado ou de tentativa de montar uma combinação que a vitrine não
 * oferece. O valor sai sempre de `preco`, que veio do banco.
 */
export function resolverPreco(
  preco: PrecoDoBanco | null,
  planoIdPedido: string,
): ResolucaoDePreco {
  if (!preco) return { compravel: false, motivo: "preco_inexistente" };
  if (!preco.ativo) return { compravel: false, motivo: "preco_inativo" };
  if (!preco.plano) return { compravel: false, motivo: "plano_ausente" };
  if (preco.planoId !== planoIdPedido) return { compravel: false, motivo: "plano_divergente" };
  if (preco.plano.id !== preco.planoId) return { compravel: false, motivo: "plano_divergente" };
  if (!preco.plano.ativo) return { compravel: false, motivo: "plano_inativo" };

  // `> 0` e inteiro. Um preço zero é uma linha de vitrine sem cobrança — nada
  // gratuito passa por PIX. Um não-inteiro seria float onde o banco promete
  // centavos, e o erro apareceria na conferência de valor da Fase 5.
  if (!Number.isInteger(preco.precoCentavos) || preco.precoCentavos <= 0) {
    return { compravel: false, motivo: "valor_invalido" };
  }
  // Exatamente uma duração: dias ou meses de calendário. As duas, ou nenhuma, é
  // linha incoerente — o CHECK do banco recusa, e aqui é a segunda camada.
  const dias = preco.duracaoDias;
  const meses = preco.duracaoMeses;
  const temDias = typeof dias === "number" && Number.isInteger(dias) && dias > 0;
  const temMeses = typeof meses === "number" && Number.isInteger(meses) && meses >= 1 && meses <= 24;
  if (temDias === temMeses) {
    return { compravel: false, motivo: "duracao_invalida" };
  }
  if (!(MOEDAS_SUPORTADAS as readonly string[]).includes(preco.moeda)) {
    return { compravel: false, motivo: "moeda_nao_suportada" };
  }

  return {
    compravel: true,
    snapshot: {
      planoId: preco.planoId,
      planoPrecoId: preco.id,
      valorCentavos: preco.precoCentavos,
      moeda: preco.moeda,
      duracaoDias: temDias ? (dias as number) : null,
      duracaoMeses: temMeses ? (meses as number) : null,
      descricao: `${nomePublicoDoPlano(preco.plano.id, preco.plano.nome)} — ${preco.rotulo}`,
    },
  };
}

// ── Fronteira de confiança do corpo do cliente ───────────────────────────────

/**
 * Campos financeiros que o cliente **nunca** decide.
 *
 * Ignorá-los silenciosamente já bastaria para a segurança — o serviço lê o
 * preço do banco e nada mais. Recusar explicitamente serve a outra coisa: torna
 * a fronteira inequívoca no código e no teste. Um cliente que envia `amount`
 * está errado sobre como esta API funciona, e uma resposta 400 diz isso; um 201
 * cobrando outro valor deixaria a dúvida de pé.
 */
export const CAMPOS_FINANCEIROS_PROIBIDOS = [
  "amount",
  "valor",
  "valorCentavos",
  "preco",
  "precoCentavos",
  "price",
  "duracaoDias",
  "duration",
  "moeda",
  "currency",
  "status",
  "provedor",
  "provider",
  "transactionId",
  "transacaoId",
  "refExterna",
  "externalRef",
  "postbackUrl",
  "metadata",
] as const;

/**
 * O primeiro campo proibido presente no corpo, ou `null`.
 *
 * `in` e não `!== undefined`: mandar `{"amount": null}` também é o cliente
 * tentando falar de dinheiro, e a fronteira não fica mais clara aceitando a
 * versão nula.
 */
export function campoFinanceiroNoCorpo(corpo: Record<string, unknown>): string | null {
  for (const campo of CAMPOS_FINANCEIROS_PROIBIDOS) {
    if (Object.prototype.hasOwnProperty.call(corpo, campo)) return campo;
  }
  return null;
}

// ── Portas ───────────────────────────────────────────────────────────────────

/**
 * Os dados do pagador exigidos pela Blackcat.
 *
 * Todos os quatro são obrigatórios na documentação do provedor. `nome` e `email`
 * saem da conta autenticada sempre que existirem; `telefone` e `documento` não
 * têm fonte no nosso banco e vêm do corpo — é a única categoria de dado do
 * cliente que esta rota aceita, e nenhum deles influencia valor.
 *
 * **Nada disto é persistido.** Atravessa o processo até a chamada HTTP e morre
 * ali. Ver a retenção mínima decidida em D-13.
 */
export interface DadosDoPagador {
  nome: string;
  email: string;
  telefone: string;
  documento: { numero: string; tipo: "cpf" | "cnpj" };
}

/** O que o provedor precisa para criar uma venda. */
export interface PedidoParaProvedor {
  refExterna: string;
  valorCentavos: number;
  moeda: string;
  descricao: string;
  pagador: DadosDoPagador;
}

/** O que uma criação bem-sucedida devolve — já normalizado, já validado. */
export interface VendaPixCriada {
  transacaoId: string;
  /** O valor que o PROVEDOR diz ter cobrado. Confrontado com o snapshot. */
  valorCentavos: number;
  expiraEm: Date;
  qrCode: string;
  copiaECola: string;
  /** Conveniência de renderização; nem sempre presente. Nunca persistido. */
  qrCodeBase64: string | null;
}

/**
 * Como a chamada ao provedor pode dar errado.
 *
 * Fechado de propósito, e sem nenhum campo livre: a mensagem crua da Blackcat
 * não entra aqui, então não há como ela vazar para o cliente por descuido de
 * quem for escrever a Fase 5.
 *
 * Os três últimos se distinguem por **o que sabemos existir do outro lado**:
 *
 *   - `resposta_invalida` — não conseguimos nem extrair um `transactionId`. Não
 *     há o que investigar depois;
 *   - `estado_externo_inesperado` — há transação, mas ela não nasceu no estado
 *     que uma criação normal produz (`PENDING`), ou já nasceu vencida;
 *   - `resposta_incompleta` — há transação, e os dados de PIX vieram
 *     inutilizáveis.
 */
export type FalhaDoProvedor =
  | "configuracao"
  | "timeout"
  | "rede"
  | "recusado"
  | "indisponivel"
  | "resposta_invalida"
  | "estado_externo_inesperado"
  | "resposta_incompleta";

/**
 * O resultado de uma tentativa de criação.
 *
 * `transacaoId` no ramo de falha é o que separa "não existe nada lá" de "existe
 * uma venda lá que não podemos usar". A regra que sai disso, aplicada em
 * `criarPedidoPix`, é única e vale para todos os motivos:
 *
 *   **transação conhecida ⇒ `REVISAO_MANUAL`. Transação desconhecida ⇒ `FALHOU`.**
 *
 * Nunca `PAGO`, em nenhum dos dois.
 */
export type ResultadoCriacaoPix =
  | { ok: true; venda: VendaPixCriada }
  | { ok: false; falha: FalhaDoProvedor; transacaoId?: string; expiraEm?: Date };

/**
 * A porta do gateway.
 *
 * Produção usa `criarProvedorBlackcat()` de `./blackcat.ts`; teste usa um objeto
 * em memória. Nenhuma implementação lança: falha externa vira `ok: false` com um
 * motivo do conjunto fechado acima.
 */
export interface ProvedorPix {
  criarVenda(pedido: PedidoParaProvedor): Promise<ResultadoCriacaoPix>;
}

/** O que o banco precisa saber fazer. Implementado sobre o Prisma na rota. */
export interface RepositorioDePedidos {
  buscarPreco(planoPrecoId: string): Promise<PrecoDoBanco | null>;
  /** Preços mensais ativos dos adicionais deste plano. */
  buscarAdicionais(planoId: string): Promise<PrecosDosAdicionais>;
  /** Assinaturas ATIVAS da conta que ainda não terminaram: a vigente e as agendadas. */
  periodosEmAberto(userId: string, agora: Date): Promise<PeriodoPago[]>;
  /** Há caso de revisão pendente para esta conta? Checagem barata, antes de tudo. */
  revisaoPendente(userId: string): Promise<boolean>;
  /**
   * Grava o pedido `CRIADO`. `null` quando a conta tem revisão pendente: a
   * implementação repete a checagem com a conta travada, na mesma transação da
   * gravação — é o que vale com requisições simultâneas.
   */
  criar(dados: NovoPedido): Promise<{ id: string } | null>;
  registrarVenda(
    pedidoId: string,
    dados: { transacaoId: string; expiraEm: Date },
  ): Promise<void>;
  /**
   * Com `REVISAO_MANUAL`, abre o caso com o `motivo` na mesma transação.
   *
   * `expiraEm` é preservado quando o provedor deu um prazo válido, mesmo que o
   * PIX tenha vindo incompleto: é o que evita a revisão nascer sem prazo e
   * impedir `confirmar_nao_pago` de resolvê-la por expiração. Nunca concede
   * direito — `REVISAO_MANUAL` não é um estado que autorize.
   */
  registrarFalha(
    pedidoId: string,
    dados: { status: "FALHOU" | "REVISAO_MANUAL"; transacaoId?: string; expiraEm?: Date; motivo?: CodigoDeRevisao },
  ): Promise<void>;
}

export type OperacaoDoPedido = "nova" | "renovacao" | "upgrade" | "downgrade";

export interface NovoPedido extends SnapshotDeCompra {
  userId: string;
  provedor: ProvedorPagamento;
  status: "CRIADO";
  refExterna: string;
  telasAdicionais: number;
  servidorVip: boolean;
  valorPlanoCentavos: number;
  valorAdicionaisCentavos: number;
  creditoCentavos: number;
  operacao: OperacaoDoPedido;
  assinaturasSubstituidas: string[];
  /** Estimativa para a resposta; o início real é recalculado na confirmação. Não é coluna. */
  iniciaEmPrevisto: Date;
}

// ── A composição da compra ───────────────────────────────────────────────────

export type CodigoDeCompraRecusada =
  | "duracao_invalida"
  | "telas_acima_do_limite"
  | "adicional_indisponivel"
  | "servidor_vip_ja_incluso"
  | "credito_maior_que_compra"
  | "parametros_invalidos";

export interface CompraMontada {
  /** `valorCentavos` já é o valor a cobrar: plano + adicionais − crédito. */
  snapshot: SnapshotDeCompra;
  valorPlanoCentavos: number;
  valorAdicionaisCentavos: number;
  creditoCentavos: number;
  operacao: OperacaoDoPedido;
  assinaturasSubstituidas: string[];
  telasAdicionais: number;
  servidorVip: boolean;
  iniciaEmPrevisto: Date;
}

/**
 * Plano na duração escolhida + adicionais + operação + crédito. Função pura.
 *
 * Tudo sai de dados do servidor: preço e duração do snapshot (`PlanoPreco`),
 * preços mensais dos adicionais (`PlanoAdicionalPreco`), ordem e VIP incluso do
 * plano, e os períodos em aberto da conta.
 *
 * Regras aprovadas:
 *  - adicionais custam `mensal × meses cobráveis` e acompanham o período inteiro;
 *  - renovação e downgrade não geram crédito (começam no fim do que já foi pago);
 *  - upgrade credita o não utilizado do vigente e o valor integral dos agendados;
 *  - o crédito precisa ser **coberto** pela compra: crédito maior ou igual ao
 *    total é recusado (`credito_maior_que_compra`) — não há saldo a guardar, nem
 *    PIX de valor zero.
 */
export function montarCompra(entrada: {
  snapshot: SnapshotDeCompra;
  plano: { ordem: number; servidorVip: boolean };
  adicionais: PrecosDosAdicionais;
  telasAdicionais: number;
  servidorVip: boolean;
  periodos: PeriodoPago[];
  agora: Date;
  /** Injetável só para teste; em produção é `SERVIDOR_VIP_AVULSO_OFERTADO`. */
  servidorVipOfertado?: boolean;
}): { ok: true; compra: CompraMontada } | { ok: false; codigo: CodigoDeCompraRecusada } {
  const { snapshot } = entrada;
  const duracao: Duracao | null =
    typeof snapshot.duracaoMeses === "number"
      ? { tipo: "meses", meses: snapshot.duracaoMeses }
      : typeof snapshot.duracaoDias === "number"
        ? { tipo: "dias", dias: snapshot.duracaoDias }
        : null;
  if (!duracao) return { ok: false, codigo: "duracao_invalida" };

  const total = calcularTotal({
    precoPlanoCentavos: snapshot.valorCentavos,
    duracao,
    telasAdicionais: entrada.telasAdicionais,
    servidorVip: entrada.servidorVip,
    planoIncluiServidorVip: entrada.plano.servidorVip === true,
    servidorVipOfertado: entrada.servidorVipOfertado ?? SERVIDOR_VIP_AVULSO_OFERTADO,
    adicionais: entrada.adicionais,
  });
  if (!total.ok) return { ok: false, codigo: total.codigo };

  const operacao = classificarOperacao({
    periodos: entrada.periodos,
    plano: { id: snapshot.planoId, ordem: entrada.plano.ordem },
    agora: entrada.agora,
  });

  let credito = 0;
  let substituidas: string[] = [];
  if (operacao.tipo === "upgrade") {
    substituidas = operacao.substitui;
    credito = entrada.periodos
      .filter((p) => substituidas.includes(p.id))
      .reduce((soma, p) => soma + valorNaoUtilizado(p, entrada.agora), 0);
    if (credito >= total.totalCentavos) return { ok: false, codigo: "credito_maior_que_compra" };
  }

  return {
    ok: true,
    compra: {
      snapshot: { ...snapshot, valorCentavos: total.totalCentavos - credito },
      valorPlanoCentavos: total.baseCentavos,
      valorAdicionaisCentavos: total.telasCentavos + total.servidorVipCentavos,
      creditoCentavos: credito,
      operacao: operacao.tipo,
      assinaturasSubstituidas: substituidas,
      telasAdicionais: entrada.telasAdicionais,
      servidorVip: entrada.servidorVip,
      iniciaEmPrevisto: operacao.iniciaEm,
    },
  };
}

// ── O serviço ────────────────────────────────────────────────────────────────

export interface EntradaDoPedido {
  userId: string;
  planoId: string;
  planoPrecoId: string;
  pagador: DadosDoPagador;
  /** Escolhas do cliente. Preço, limite e disponibilidade são do servidor. */
  telasAdicionais?: number;
  servidorVip?: boolean;
}

export interface DependenciasDoPedido {
  repo: RepositorioDePedidos;
  provedor: ProvedorPix;
  /** Injetável para o teste não depender de `randomBytes` real. */
  gerarRef?: () => string;
  /** Relógio injetável; produção usa `new Date()`. */
  agora?: () => Date;
  /** Quem processa a cobrança. Padrão `blackcat`. */
  nomeDoProvedor?: ProvedorPagamento;
}

/** Por que um pedido foi parar em `REVISAO_MANUAL`. Só para log sanitizado. */
export type MotivoDeRevisao = "valor_divergente" | FalhaDoProvedor;

export type ResultadoDoPedido =
  | {
      situacao: "criado";
      pedidoId: string;
      status: "AGUARDANDO";
      valorCentavos: number;
      moeda: string;
      expiraEm: Date;
      operacao: OperacaoDoPedido;
      creditoCentavos: number;
      iniciaEmPrevisto: Date;
      pix: { qrCode: string; copiaECola: string; qrCodeBase64: string | null };
    }
  | { situacao: "nao_compravel"; motivo: MotivoNaoCompravel }
  | { situacao: "compra_recusada"; codigo: CodigoDeCompraRecusada }
  /** Conta com pagamento em revisão: nenhuma compra nova até o caso ser resolvido. */
  | { situacao: "revisao_pendente" }
  | { situacao: "falha_no_provedor"; falha: FalhaDoProvedor; pedidoId: string }
  | { situacao: "revisao_manual"; pedidoId: string; motivo: MotivoDeRevisao };

/**
 * Cria o pedido local e a venda PIX no provedor.
 *
 * Ordem, e cada passo tem um motivo:
 *
 *  1. **lê o preço no banco** — o cliente mandou identificadores, não valor;
 *  2. **resolve** — preço inexistente, inativo, de plano inativo, incoerente,
 *     zerado ou em moeda não suportada param aqui, **sem tocar no provedor**.
 *     Um pedido recusado não pode custar uma requisição externa nem deixar
 *     linha no banco;
 *  3. **grava `CRIADO`** — antes da chamada externa, de propósito. Se a Blackcat
 *     criar a venda e nós nunca soubermos, ainda assim existe do nosso lado uma
 *     linha com a `refExterna` que aquela venda carrega;
 *  4. **chama o provedor**;
 *  5. **confere o valor** contra o snapshot;
 *  6. **grava `AGUARDANDO`** com `transacaoId` e `expiraEm`.
 *
 * ## O que NÃO acontece aqui, em nenhum ramo
 *
 * Nenhuma escrita em `Assinatura`. Nenhuma chamada a `invalidarEntitlements`.
 * Nenhum `PAGO`. Uma resposta de criação — mesmo que venha com `status: "PAID"`
 * — é notícia de que a venda existe, nunca prova de que foi paga.
 *
 * ## O risco residual, dito com clareza
 *
 * Postgres e Blackcat não participam da mesma transação, e **nenhuma transação
 * SQL resolve isso**. Existe uma janela real: a venda é criada lá e a gravação
 * do `transacaoId` falha aqui (rede, timeout do nosso lado, banco fora). O
 * pedido fica `CRIADO` ou `FALHOU` enquanto a venda existe e é pagável.
 *
 * O que reduz o dano, e é o máximo honesto para esta fase:
 *
 *   - `refExterna` vai no `externalRef` da Blackcat, então a venda órfã é
 *     rastreável até o pedido — não é preciso adivinhar por valor e horário;
 *   - `transacaoId` é único no banco, então a Fase 5 não consegue ativar duas
 *     assinaturas a partir da mesma transação ao consertar isto;
 *   - a reconciliação da Fase 5 é o que fecha a janela de fato.
 *
 * Um `timeout` é indistinguível de "criou e não respondeu". `FALHOU` aqui
 * significa "não conseguimos concluir", nunca "não existe venda lá".
 */
export async function criarPedidoPix(
  entrada: EntradaDoPedido,
  deps: DependenciasDoPedido,
): Promise<ResultadoDoPedido> {
  const { repo, provedor } = deps;
  const gerarRef = deps.gerarRef ?? gerarRefExterna;

  // Revisão pendente bloqueia qualquer compra da conta: um segundo pagamento
  // enquanto o primeiro está em análise é exatamente o que a mensagem ao
  // comprador pede para não acontecer. `criar` repete a checagem com trava.
  if (await repo.revisaoPendente(entrada.userId)) return { situacao: "revisao_pendente" };

  const preco = await repo.buscarPreco(entrada.planoPrecoId);
  const resolucao = resolverPreco(preco, entrada.planoId);
  if (!resolucao.compravel) {
    return { situacao: "nao_compravel", motivo: resolucao.motivo };
  }

  const agora = deps.agora ? deps.agora() : new Date();
  const [adicionais, periodos] = await Promise.all([
    repo.buscarAdicionais(resolucao.snapshot.planoId),
    repo.periodosEmAberto(entrada.userId, agora),
  ]);
  const montagem = montarCompra({
    snapshot: resolucao.snapshot,
    plano: { ordem: preco?.plano?.ordem ?? 0, servidorVip: preco?.plano?.servidorVip === true },
    adicionais,
    telasAdicionais: entrada.telasAdicionais ?? 0,
    servidorVip: entrada.servidorVip === true,
    periodos,
    agora,
  });
  if (!montagem.ok) return { situacao: "compra_recusada", codigo: montagem.codigo };

  const { compra } = montagem;
  // A partir daqui, `snapshot.valorCentavos` é o valor a cobrar (plano +
  // adicionais − crédito), calculado só com dados do servidor.
  const snapshot = compra.snapshot;
  const refExterna = gerarRef();

  const criado = await repo.criar({
    ...snapshot,
    userId: entrada.userId,
    provedor: deps.nomeDoProvedor ?? "blackcat",
    status: "CRIADO",
    refExterna,
    telasAdicionais: compra.telasAdicionais,
    servidorVip: compra.servidorVip,
    valorPlanoCentavos: compra.valorPlanoCentavos,
    valorAdicionaisCentavos: compra.valorAdicionaisCentavos,
    creditoCentavos: compra.creditoCentavos,
    operacao: compra.operacao,
    assinaturasSubstituidas: compra.assinaturasSubstituidas,
    iniciaEmPrevisto: compra.iniciaEmPrevisto,
  });
  // Uma revisão foi aberta entre a primeira checagem e a gravação.
  if (!criado) return { situacao: "revisao_pendente" };
  const pedidoId = criado.id;

  const resultado = await provedor.criarVenda({
    refExterna,
    // Do snapshot, sempre. Nunca de `entrada`, que veio do cliente.
    valorCentavos: snapshot.valorCentavos,
    moeda: snapshot.moeda,
    descricao: snapshot.descricao,
    pagador: entrada.pagador,
  });

  if (!resultado.ok) {
    // A regra única: se sabemos o `transactionId`, existe uma venda do outro
    // lado — e ela pode ser pagável. `FALHOU` diria "não há nada lá" e faria a
    // reconciliação da Fase 5 pular justamente a linha que precisa de gente
    // olhando. Gravar o `transacaoId` é o que torna o cruzamento possível, e
    // não concede nada: `REVISAO_MANUAL` não é um estado que autorize.
    if (resultado.transacaoId) {
      await repo.registrarFalha(pedidoId, {
        status: "REVISAO_MANUAL",
        transacaoId: resultado.transacaoId,
        // Quando o provedor deu um prazo válido, ele é preservado junto da
        // transação — mesmo com o PIX incompleto. Sem isso a revisão nasce com
        // `expiraEm` nulo e a resolução por expiração fica impossível.
        ...(resultado.expiraEm ? { expiraEm: resultado.expiraEm } : {}),
        motivo: "criacao_falha_com_transacao",
      });
      return { situacao: "revisao_manual", pedidoId, motivo: resultado.falha };
    }

    await repo.registrarFalha(pedidoId, { status: "FALHOU" });
    return { situacao: "falha_no_provedor", falha: resultado.falha, pedidoId };
  }

  const venda = resultado.venda;

  // O valor divergente é o caso que merece a distinção mais cara deste arquivo.
  //
  // REVISAO_MANUAL, e não FALHOU: a venda **existe** no provedor, com um
  // `transactionId` que conhecemos e um valor que não é o que combinamos. Ela é
  // pagável. `FALHOU` diria "não há nada lá" e faria a reconciliação da Fase 5
  // ignorar justamente a linha que precisa de gente olhando.
  //
  // O `transacaoId` é gravado **por isso**: sem ele, o pedido em revisão não
  // teria como ser cruzado com a venda no painel do provedor. Não é concessão de
  // nada — `REVISAO_MANUAL` não é um estado que autorize.
  if (venda.valorCentavos !== snapshot.valorCentavos) {
    await repo.registrarFalha(pedidoId, {
      status: "REVISAO_MANUAL",
      transacaoId: venda.transacaoId,
      // A venda existe e tem prazo válido; preservá-lo mantém a revisão
      // resolvível por expiração, sem conceder nada.
      expiraEm: venda.expiraEm,
      motivo: "criacao_valor_divergente",
    });
    return { situacao: "revisao_manual", pedidoId, motivo: "valor_divergente" };
  }

  await repo.registrarVenda(pedidoId, {
    transacaoId: venda.transacaoId,
    expiraEm: venda.expiraEm,
  });

  return {
    situacao: "criado",
    pedidoId,
    status: "AGUARDANDO",
    valorCentavos: snapshot.valorCentavos,
    moeda: snapshot.moeda,
    expiraEm: venda.expiraEm,
    operacao: compra.operacao,
    creditoCentavos: compra.creditoCentavos,
    iniciaEmPrevisto: compra.iniciaEmPrevisto,
    pix: {
      qrCode: venda.qrCode,
      copiaECola: venda.copiaECola,
      qrCodeBase64: venda.qrCodeBase64,
    },
  };
}
