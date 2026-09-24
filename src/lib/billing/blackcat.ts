/**
 * O provedor PIX da Blackcat — a única parte do sistema que fala com ela.
 *
 * Implementa a porta `ProvedorPix` de `./pedidos.ts`. O serviço de pedidos não
 * sabe que a Blackcat existe; sabe que há um provedor que devolve `ok: true` com
 * uma venda ou `ok: false` com um dos motivos do conjunto fechado.
 *
 * ## Regras que não se negociam neste arquivo
 *
 * **`BLACKCAT_API_KEY` só existe aqui, e só no servidor.** Não há `NEXT_PUBLIC_`
 * dela, ela não entra em `BuildConfig` do Android, em `preload.js` do Electron,
 * em Kotlin, no Git, em log, em resposta HTTP nem em mensagem de erro. O único
 * lugar em que ela aparece é o header `X-API-Key` da requisição abaixo.
 *
 * **Nada do corpo da resposta vira log ou erro visível.** A resposta traz QR,
 * copia-e-cola e dados do pagador. `console.log` de `body` aqui colocaria meio
 * de pagamento no Vercel Logs. O que sai daqui para o log é o motivo
 * classificado e, quando houver, o status HTTP — nada mais. A única exceção é o
 * diagnóstico ESTRUTURAL da resposta de status (`diagnosticarRespostaConfirmacao`):
 * ele registra apenas flags de presença/tipo — nunca um valor do corpo.
 *
 * **Nenhuma URL vem do cliente.** O endpoint é montado a partir de uma base fixa
 * (ou de `BLACKCAT_API_BASE_URL`, variável de servidor). Não existe caminho em
 * que um valor do corpo do pedido escolha host, porta ou rota — é o que fecha
 * SSRF por aqui.
 *
 * ## Sobre o contrato
 *
 * O corpo enviado usa **exatamente** os nomes e tipos da documentação da
 * Blackcat fornecida ao projeto (`amount`, `currency`, `paymentMethod`, `items`,
 * `customer`, `pix`, `externalRef`) — nenhum campo foi deduzido a partir do nome
 * de algo na resposta, e nenhum exemplo de outro gateway foi copiado.
 *
 * `postbackUrl` só é enviado quando `BLACKCAT_CONFIRMACAO_ATIVA === "true"`.
 * Nesse caso ele é montado exclusivamente no servidor a partir de `NEXTAUTH_URL`
 * e `BLACKCAT_WEBHOOK_PATH_SECRET`. Se essa configuração estiver incompleta ou
 * não for HTTPS, a integração falha fechada e não cria o PIX.
 *
 * `metadata` e os cinco campos `utm_*` também não são enviados: são opcionais,
 * não servem a esta fase, e cada um deles é um lugar a mais por onde dado nosso
 * sairia para um terceiro sem necessidade.
 *
 * ## Duas condições para "criação bem-sucedida", não uma
 *
 * `HTTP 201` **e** `data.status === "PENDING"`. O primeiro diz que a requisição
 * foi aceita; o segundo, em que estado a venda nasceu. Qualquer outro estado —
 * `PAID`, `CANCELLED`, `REFUNDED`, ausente ou desconhecido — não devolve PIX
 * como sucesso, e em nenhuma hipótese vira `PAGO`. Ver `interpretarVenda`.
 */

import { audit } from "@/lib/auditLog";
import type {
  PedidoParaProvedor,
  ProvedorPix,
  ResultadoCriacaoPix,
  VendaPixCriada,
} from "./pedidos";

/** A base documentada. Produção usa esta; só teste/staging troca. */
export const BASE_BLACKCAT_PADRAO = "https://api.blackcatoficial.com/api";

/** Tempo máximo esperando a Blackcat. Ver a nota sobre timeout adiante. */
export const TIMEOUT_MS = 15_000;
export const TIMEOUT_CONFIRMACAO_MS = 8_000;

/** O HTTP que a documentação promete para uma criação bem-sucedida. */
export const STATUS_DE_SUCESSO = 201;

// ── Configuração ─────────────────────────────────────────────────────────────

export interface ConfiguracaoBlackcat {
  apiKey: string;
  baseUrl: string;
  postbackUrl?: string;
}

/**
 * Lê a configuração do ambiente, ou devolve `null`.
 *
 * `null` — e não uma exceção com o nome da variável — porque quem chama
 * transforma isso num 503 genérico. "BLACKCAT_API_KEY missing" numa resposta
 * HTTP é um oráculo de configuração: diz a quem estiver sondando exatamente qual
 * integração existe e o que falta para ela funcionar.
 *
 * `BLACKCAT_API_BASE_URL` é opcional e existe só para apontar a um ambiente de
 * teste do provedor. É recusada se não for `https:` — um `http://` aqui mandaria
 * a chave de API em claro. **O cliente não a fornece em hipótese alguma**: é
 * variável de servidor, e nenhum campo do corpo do pedido a alcança.
 */
export function lerConfiguracao(
  env: Record<string, string | undefined> = process.env,
): ConfiguracaoBlackcat | null {
  const apiKey = env.BLACKCAT_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") return null;

  let baseUrl = BASE_BLACKCAT_PADRAO;
  const bruta = env.BLACKCAT_API_BASE_URL;

  if (bruta !== undefined && bruta.trim() !== "") {
    let url: URL;

    try {
      url = new URL(bruta);
    } catch {
      return null;
    }

    if (url.protocol !== "https:") return null;
    baseUrl = bruta.replace(/\/+$/, "");
  }

  let postbackUrl: string | undefined;

  if (env.BLACKCAT_CONFIRMACAO_ATIVA === "true") {
    const origemBruta = env.NEXTAUTH_URL?.trim();
    const segredo = env.BLACKCAT_WEBHOOK_PATH_SECRET?.trim();

    if (!origemBruta || !segredo) return null;

    let origem: URL;

    try {
      origem = new URL(origemBruta);
    } catch {
      return null;
    }

    if (origem.protocol !== "https:") return null;

    postbackUrl =
      `${origem.origin}/api/billing/webhook/blackcat/${encodeURIComponent(segredo)}`;
  }

  return postbackUrl
    ? { apiKey, baseUrl, postbackUrl }
    : { apiKey, baseUrl };
}

// ── Validação da resposta ────────────────────────────────────────────────────

/**
 * **O único `status` que uma criação normal produz.**
 *
 * A documentação da Blackcat descreve quatro estados — `PENDING`, `PAID`,
 * `CANCELLED`, `REFUNDED` — e o exemplo de criação bem-sucedida devolve
 * `PENDING`. É o único que significa "a venda foi criada e está esperando
 * pagamento", que é exatamente o que esta fase pede ao provedor.
 *
 * **HTTP 201 sozinho não basta**, e essa é a correção que este bloco existe para
 * travar. `201` diz que o pedido HTTP foi aceito; `status` diz em que estado o
 * recurso nasceu. Uma venda que já nasce `PAID` na resposta de criação não é uma
 * compra concluída — é uma anomalia, e tratá-la como sucesso seria o começo do
 * caminho que ativa assinatura sem confirmação servidor→servidor. `CANCELLED` e
 * `REFUNDED` numa criação também não têm leitura honesta, e um estado ausente ou
 * desconhecido é o caso em que menos se pode presumir.
 */
export const STATUS_DE_CRIACAO_ACEITO = "PENDING";

/**
 * O que a leitura da resposta pode concluir.
 *
 * A distinção entre `invalida` e `recusada` é a que importa depois: `recusada`
 * carrega um `transacaoId`, ou seja, **existe uma venda do outro lado**, e o
 * serviço manda o pedido para `REVISAO_MANUAL` em vez de `FALHOU`. `invalida` é
 * quando não há nem isso.
 */
export type LeituraDaVenda =
  | { situacao: "ok"; venda: VendaPixCriada }
  | { situacao: "invalida" }
  | {
      situacao: "recusada";
      transacaoId: string;
      falha: "estado_externo_inesperado" | "resposta_incompleta";
      /**
       * O `expiresAt` do provedor, quando veio válido, **mesmo que a recusa
       * tenha sido por outro dado do PIX faltando**. É o que permite persistir
       * `expiraEm` junto do `transacaoId` no caso de revisão: sem ele,
       * `confirmar_nao_pago` não consegue resolver um `PENDING` por expiração e a
       * revisão fica presa. Ausente quando a própria data veio inválida.
       */
      expiraEm?: Date;
    };

/**
 * Lê `data` de uma criação de PIX, conferindo campo a campo.
 *
 * Declarado como `unknown` e conferido item a item, e não tipado por asserção:
 * `response.json()` devolve o que o outro lado quiser mandar, e um `as` aqui
 * faria o TypeScript prometer o que ninguém verificou.
 *
 * `agora` é injetável para os testes de expiração não dependerem do relógio.
 */
export function interpretarVenda(
  bruto: unknown,
  agora: Date = new Date(),
): LeituraDaVenda {
  const invalida = { situacao: "invalida" } as const;

  if (!bruto || typeof bruto !== "object") return invalida;
  const raiz = bruto as Record<string, unknown>;

  const dados = raiz.data;
  if (!dados || typeof dados !== "object") return invalida;
  const d = dados as Record<string, unknown>;

  const transacaoId = typeof d.transactionId === "string" ? d.transactionId.trim() : "";
  if (!transacaoId) return invalida;

  // Daqui para baixo sabemos que existe uma venda no provedor. Toda recusa
  // passa a carregar o `transacaoId`, porque é ele que permite a Fase 5
  // investigar em vez de descartar. Quando o `expiresAt` já foi lido e é válido,
  // a recusa carrega também `expiraEm` — sem ele a revisão nasce sem prazo e
  // `confirmar_nao_pago` não consegue resolvê-la por expiração.
  const recusar = (
    falha: "estado_externo_inesperado" | "resposta_incompleta",
    expiraEm?: Date,
  ): LeituraDaVenda =>
    expiraEm
      ? { situacao: "recusada", transacaoId, falha, expiraEm }
      : { situacao: "recusada", transacaoId, falha };

  // Comparação estrita com a string exata. Sem `toUpperCase()`, sem aceitar
  // variação: um estado que não é o documentado é um estado sobre o qual não
  // temos contrato, e presumir é o erro que esta fase inteira evita.
  if (d.status !== STATUS_DE_CRIACAO_ACEITO) return recusar("estado_externo_inesperado");

  // Inteiro, e nada de coerção. `Number("1000")` transformaria uma string num
  // valor que a conferência de valor aceitaria — e a conferência de valor é a
  // única defesa contra cobrar diferente do combinado.
  const valorCentavos = d.amount;
  if (typeof valorCentavos !== "number" || !Number.isInteger(valorCentavos)) {
    return recusar("resposta_incompleta");
  }

  const pagamento = d.paymentData;
  if (!pagamento || typeof pagamento !== "object") return recusar("resposta_incompleta");
  const p = pagamento as Record<string, unknown>;

  // `expiresAt` é lido primeiro, de propósito: se o PIX vier incompleto por
  // outro campo, ainda queremos preservar o prazo na revisão. `null` quando a
  // data faltou ou veio impossível de interpretar.
  const expiraEmBruto = typeof p.expiresAt === "string" ? new Date(p.expiresAt) : null;
  const expiraEm =
    expiraEmBruto && !Number.isNaN(expiraEmBruto.getTime()) ? expiraEmBruto : null;

  const qrCode = typeof p.qrCode === "string" ? p.qrCode.trim() : "";
  const copiaECola = typeof p.copyPaste === "string" ? p.copyPaste.trim() : "";

  // `qrCodeBase64` é uma representação de QR já pronta para desenhar (o checkout
  // renderiza a imagem a partir dela). É normalizada só no trim — o conteúdo
  // sensível não é tocado — e permanece opcional.
  const qrCodeBase64 = typeof p.qrCodeBase64 === "string" && p.qrCodeBase64.trim()
    ? p.qrCodeBase64.trim()
    : null;

  // O copia-e-cola é obrigatório e insubstituível: é ele que paga o PIX. Além
  // dele, basta **uma** representação de QR utilizável — `qrCode` (o payload que
  // o cliente pode desenhar) ou `qrCodeBase64` (a imagem pronta). Recusar por
  // faltar uma representação redundante quando a outra veio era o que mandava
  // PIX pagável para REVISAO_MANUAL sem necessidade.
  if (!copiaECola || (!qrCode && !qrCodeBase64)) {
    return recusar("resposta_incompleta", expiraEm ?? undefined);
  }

  if (!expiraEm) return recusar("resposta_incompleta");

  // Um PIX que já nasce vencido não é pagável, e entregá-lo ao usuário seria
  // mandá-lo tentar pagar algo que o provedor já recusa. É estado externo
  // inesperado, não resposta malformada — a resposta está bem formada, o que
  // está errado é o que ela diz.
  //
  // `<=` e não `<`: expirar exatamente agora já não dá tempo de pagar.
  if (expiraEm.getTime() <= agora.getTime()) {
    return recusar("estado_externo_inesperado", expiraEm);
  }

  return {
    situacao: "ok",
    venda: { transacaoId, valorCentavos, expiraEm, qrCode, copiaECola, qrCodeBase64 },
  };
}

/**
 * Traduz um status HTTP inesperado num motivo do conjunto fechado.
 *
 * A separação entre `recusado` e `indisponivel` existe para a Fase 5 e para o
 * log: 4xx é problema do que enviamos (chave inválida, conta bloqueada,
 * validação) e repetir não adianta; 5xx é problema do outro lado e repetir pode
 * adiantar. Nenhuma das duas vira mensagem para o usuário.
 */
export function classificarStatus(status: number): "recusado" | "indisponivel" {
  return status >= 500 ? "indisponivel" : "recusado";
}

export type StatusBlackcat = "PENDING" | "PAID" | "CANCELLED" | "REFUNDED";
export type ConfirmacaoBlackcat = { transactionId: string; status: StatusBlackcat; amount: number; paidAt: Date | null };
/**
 * Por que a consulta autoritativa não devolveu um status. Conjunto fechado, sem
 * campo livre: a mensagem crua da Blackcat não entra aqui. `nao_encontrada` e
 * `recusada` vêm de 4xx (não adianta repetir); `indisponivel` de 429/5xx (pode
 * adiantar); `resposta_invalida` de corpo/forma que a validação recusa.
 */
export type FalhaConfirmacaoBlackcat =
  | "timeout" | "rede" | "nao_encontrada" | "recusada" | "indisponivel" | "resposta_invalida";
export type ResultadoConfirmacaoBlackcat =
  | { ok: true; confirmacao: ConfirmacaoBlackcat }
  | { ok: false; falha: FalhaConfirmacaoBlackcat };

/** Contrato documentado de GET /sales/{transactionId}/status; nada cru sai daqui. */
export function interpretarConfirmacao(bruto: unknown): ConfirmacaoBlackcat | null {
  if (!bruto || typeof bruto !== "object") return null;
  const raiz = bruto as Record<string, unknown>;
  if (raiz.success !== true) return null;
  const data = raiz.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const transactionId = typeof d.transactionId === "string" ? d.transactionId.trim() : "";
  const amount = d.amount;
  if (!transactionId || !["PENDING", "PAID", "CANCELLED", "REFUNDED"].includes(String(d.status)) || typeof amount !== "number" || !Number.isInteger(amount)) return null;

  // `paidAt` é o instante do pagamento — e uma transação **não paga** o traz como
  // `null`, não ausente. O provedor devolve `paidAt: null` numa resposta normal
  // de PENDING/CANCELLED/REFUNDED, e tratar isso como corpo inválido era o que
  // prendia a reconciliação (o caso real diagnosticado). Regras:
  //   - `undefined` ou `null` → sem pagamento (`paidAt` interno = null);
  //   - string de data válida → `Date`;
  //   - string inválida ou qualquer outro tipo (número, objeto) → recusa.
  // Nada mais é afrouxado: `amount` continua inteiro, `status` continua no
  // conjunto fechado, envelope continua exigindo `success:true` e `data` objeto.
  let paidAt: Date | null = null;
  if (d.paidAt !== undefined && d.paidAt !== null) {
    if (typeof d.paidAt !== "string") return null;
    paidAt = new Date(d.paidAt);
    if (Number.isNaN(paidAt.getTime())) return null;
  }

  // `PAID` sem um `paidAt` datável não é um pago confiável: exige a comprovação
  // temporal. `PAID` com `null`/ausente continua inválido — é o que impede tomar
  // por confirmado um pagamento sem instante.
  if (d.status === "PAID" && paidAt === null) return null;

  return { transactionId, status: d.status as StatusBlackcat, amount, paidAt };
}

/**
 * Radiografia ESTRUTURAL de uma resposta 2xx que `interpretarConfirmacao`
 * recusou. Só flags de presença/tipo e o `typeof` de `amount` — **nenhum
 * valor**. Não há como transactionId real, status literal, amount, paidAt,
 * documento, e-mail, telefone, chave ou corpo cru atravessar este resultado: o
 * que sai são booleanos e um nome de tipo. É o que permite descobrir QUAL campo
 * do contrato diverge sem registrar dado sensível.
 *
 * Puro e sem efeito: quem loga é o confirmador, e só com o que sai daqui.
 */
export interface DiagnosticoRespostaConfirmacao {
  raizObjeto: boolean;
  successPresente: boolean;
  successBooleano: boolean;
  successTrue: boolean;
  dataPresente: boolean;
  dataObjeto: boolean;
  transactionIdPresente: boolean;
  transactionIdString: boolean;
  transactionIdNaoVazio: boolean;
  statusPresente: boolean;
  statusString: boolean;
  statusReconhecido: boolean;
  amountPresente: boolean;
  /** `typeof data.amount` — categoria ("number"/"string"/…), nunca o valor. */
  amountTipo: string;
  amountNumero: boolean;
  amountInteiro: boolean;
  paidAtPresente: boolean;
  paidAtString: boolean;
  paidAtDataValida: boolean;
}

export function diagnosticarRespostaConfirmacao(bruto: unknown): DiagnosticoRespostaConfirmacao {
  const raizObjeto = !!bruto && typeof bruto === "object";
  const raiz = (raizObjeto ? bruto : {}) as Record<string, unknown>;

  const successPresente = Object.prototype.hasOwnProperty.call(raiz, "success");
  const successBooleano = typeof raiz.success === "boolean";
  const successTrue = raiz.success === true;

  const dataPresente = Object.prototype.hasOwnProperty.call(raiz, "data");
  const dataBruta = raiz.data;
  const dataObjeto = !!dataBruta && typeof dataBruta === "object";
  const d = (dataObjeto ? dataBruta : {}) as Record<string, unknown>;

  const transactionIdPresente = Object.prototype.hasOwnProperty.call(d, "transactionId");
  const transactionIdString = typeof d.transactionId === "string";
  const transactionIdNaoVazio = transactionIdString && (d.transactionId as string).trim().length > 0;

  const statusPresente = Object.prototype.hasOwnProperty.call(d, "status");
  const statusString = typeof d.status === "string";
  const statusReconhecido =
    statusString && ["PENDING", "PAID", "CANCELLED", "REFUNDED"].includes(d.status as string);

  const amountPresente = Object.prototype.hasOwnProperty.call(d, "amount");
  const amountTipo = typeof d.amount;
  const amountNumero = amountTipo === "number";
  const amountInteiro = amountNumero && Number.isInteger(d.amount as number);

  const paidAtPresente = Object.prototype.hasOwnProperty.call(d, "paidAt");
  const paidAtString = typeof d.paidAt === "string";
  const paidAtDataValida = paidAtString && !Number.isNaN(new Date(d.paidAt as string).getTime());

  return {
    raizObjeto, successPresente, successBooleano, successTrue, dataPresente, dataObjeto,
    transactionIdPresente, transactionIdString, transactionIdNaoVazio,
    statusPresente, statusString, statusReconhecido,
    amountPresente, amountTipo, amountNumero, amountInteiro,
    paidAtPresente, paidAtString, paidAtDataValida,
  };
}

/**
 * Serializa o diagnóstico em `chave=valor` para o `detail` do audit. Como a
 * entrada é só booleano e nome de tipo, a string resultante é segura por
 * construção — não existe caminho por onde um valor sensível entre.
 */
export function formatarDiagnosticoConfirmacao(
  extras: { jsonParseOk: boolean; contentTypeJson: boolean },
  diag: DiagnosticoRespostaConfirmacao | null,
): string {
  const partes = [
    `jsonParseOk=${extras.jsonParseOk}`,
    `contentTypeJson=${extras.contentTypeJson}`,
  ];
  if (diag) {
    for (const [chave, valor] of Object.entries(diag)) partes.push(`${chave}=${valor}`);
  }
  return partes.join(" ");
}

export function criarConfirmadorBlackcat(
  env: Record<string, string | undefined> = process.env,
  buscar: typeof fetch = fetch,
  registrar: typeof audit = audit,
) {
  const config = lerConfiguracao(env); if (!config) return null;
  return async (transactionId: string): Promise<ResultadoConfirmacaoBlackcat> => {
    let resposta: Response;
    try { resposta = await buscar(`${config.baseUrl}/sales/${encodeURIComponent(transactionId)}/status`, { method: "GET", headers: { "X-API-Key": config.apiKey }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_CONFIRMACAO_MS) }); }
    catch (erro) { return { ok: false, falha: erro instanceof Error && (erro.name === "TimeoutError" || erro.name === "AbortError") ? "timeout" : "rede" }; }
    // !ok mantém a classificação por status HTTP, sem tocar no corpo.
    if (!resposta.ok) return { ok: false, falha: resposta.status === 404 ? "nao_encontrada" : [401, 403, 422].includes(resposta.status) ? "recusada" : "indisponivel" };

    // 2xx: aqui mora o `resposta_invalida`. Um diagnóstico ESTRUTURAL (só
    // presença/tipo, nunca valores) é registrado para revelar QUAL campo do
    // contrato diverge — sem que o parser financeiro seja afrouxado.
    const contentTypeJson = /application\/json/i.test(resposta.headers.get("content-type") ?? "");
    let corpo: unknown;
    try { corpo = await resposta.json(); }
    catch {
      registrar("billing_confirmation_shape", { detail: formatarDiagnosticoConfirmacao({ jsonParseOk: false, contentTypeJson }, null) });
      return { ok: false, falha: "resposta_invalida" };
    }

    const confirmacao = interpretarConfirmacao(corpo);
    if (confirmacao) return { ok: true, confirmacao };

    registrar("billing_confirmation_shape", {
      detail: formatarDiagnosticoConfirmacao({ jsonParseOk: true, contentTypeJson }, diagnosticarRespostaConfirmacao(corpo)),
    });
    return { ok: false, falha: "resposta_invalida" };
  };
}

// ── O provedor ───────────────────────────────────────────────────────────────

/**
 * Monta o provedor real.
 *
 * Devolve `null` quando a configuração falta — a rota transforma isso num 503
 * **sem criar pedido e sem chamar nada**. Falta de chave é falha de configuração
 * nossa, e não pode virar uma linha de cobrança pendurada no banco.
 */
export function criarProvedorBlackcat(
  env: Record<string, string | undefined> = process.env,
): ProvedorPix | null {
  const config = lerConfiguracao(env);
  if (!config) return null;
  return provedorComConfiguracao(config);
}

/**
 * O provedor sobre uma configuração já resolvida.
 *
 * Separado de `criarProvedorBlackcat` para o teste exercitar a requisição com um
 * `fetch` próprio, sem tocar em `process.env` e sem chegar perto da rede.
 */
export function provedorComConfiguracao(
  config: ConfiguracaoBlackcat,
  buscar: typeof fetch = fetch,
): ProvedorPix {
  return {
    async criarVenda(pedido: PedidoParaProvedor): Promise<ResultadoCriacaoPix> {
      // O corpo, com os nomes exatos da documentação da Blackcat.
      //
      // `items` com um item só: a compra é uma assinatura, não um carrinho.
      // `tangible: false` porque é produto digital — e é o que dispensa o objeto
      // `shipping`, que a documentação torna obrigatório quando algum item é
      // físico. `unitPrice` repete `amount` porque a quantidade é 1; enviar os
      // dois é o que a tabela de campos pede.
      const corpo = {
        amount: pedido.valorCentavos,
        currency: pedido.moeda,
        paymentMethod: "pix",
        items: [
          {
            title: pedido.descricao,
            unitPrice: pedido.valorCentavos,
            quantity: 1,
            tangible: false,
          },
        ],
        customer: {
          name: pedido.pagador.nome,
          email: pedido.pagador.email,
          phone: pedido.pagador.telefone,
          document: {
            number: pedido.pagador.documento.numero,
            type: pedido.pagador.documento.tipo,
          },
        },
        // Nossa referência, para a venda ser rastreável até o pedido mesmo que a
        // resposta se perca. É o campo documentado para isso — não foi inventado.
        externalRef: pedido.refExterna,
        ...(config.postbackUrl ? { postbackUrl: config.postbackUrl } : {}),
      };

      let resposta: Response;
      try {
        resposta = await buscar(`${config.baseUrl}/sales/create-sale`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": config.apiKey,
          },
          body: JSON.stringify(corpo),
          cache: "no-store",
          // Sem timeout, uma Blackcat lenta seguraria a função serverless até o
          // limite da Vercel e o usuário ficaria olhando uma tela parada sem
          // saber se pagou. Com timeout, sabemos que não concluímos — mas não
          // sabemos se a venda foi criada lá. Ver o risco residual em
          // `criarPedidoPix`.
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (erro) {
        const abortou =
          erro instanceof Error && (erro.name === "TimeoutError" || erro.name === "AbortError");
        return { ok: false, falha: abortou ? "timeout" : "rede" };
      }

      // Estrito: a documentação promete 201 para criação. Aceitar 200 seria
      // aceitar uma resposta que a documentação não descreve, e o que viesse
      // dentro dela não teria contrato.
      //
      // **E 201 é necessário, não suficiente.** Ele diz que o pedido HTTP foi
      // aceito; quem diz em que estado a venda nasceu é `data.status`, conferido
      // em `interpretarVenda` contra `STATUS_DE_CRIACAO_ACEITO`.
      if (resposta.status !== STATUS_DE_SUCESSO) {
        return { ok: false, falha: classificarStatus(resposta.status) };
      }

      // `.json()` lança em corpo vazio ou malformado, e o `catch` é o que impede
      // isso de virar erro 500 sem classificação.
      let payload: unknown;
      try {
        payload = await resposta.json();
      } catch {
        return { ok: false, falha: "resposta_invalida" };
      }

      const leitura = interpretarVenda(payload);
      if (leitura.situacao === "invalida") {
        return { ok: false, falha: "resposta_invalida" };
      }
      if (leitura.situacao === "recusada") {
        // Com `transacaoId`: o serviço manda para REVISAO_MANUAL, não FALHOU.
        // `expiraEm` viaja junto quando o provedor deu um prazo válido, para a
        // revisão poder ser resolvida por expiração mais tarde.
        return leitura.expiraEm
          ? { ok: false, falha: leitura.falha, transacaoId: leitura.transacaoId, expiraEm: leitura.expiraEm }
          : { ok: false, falha: leitura.falha, transacaoId: leitura.transacaoId };
      }

      // Nenhuma conferência de VALOR aqui, e é deliberado: o snapshot do pedido
      // não chega a este módulo, e a comparação precisa ser feita contra ele.
      // `criarPedidoPix` faz isso, e é lá que o teste dela vive. O que este
      // módulo já garantiu é o estado: `PENDING` e ainda não vencido.
      return { ok: true, venda: leitura.venda };
    },
  };
}
