/**
 * As opções comerciais do pedido além de plano e duração: cupom e adicionais.
 *
 * ## Por que tudo é recusado hoje
 *
 * - **Cupom:** não existe catálogo de cupons — nem tabela, nem regra de desconto
 *   aprovada. Aceitar um código sem ter como validá-lo seria desconto inventado.
 *   Qualquer cupom informado é recusado com `cupom_invalido`, e o pedido não é
 *   criado.
 * - **Telas adicionais:** faltam quantidade máxima, validade, cálculo para 5
 *   meses e 1 ano e regra durante assinatura vigente.
 * - **Servidor VIP avulso (Básico):** falta a validade do adicional e o direito
 *   `servidorVip` no schema.
 *
 * O contrato já existe para o checkout enviar as escolhas; o servidor recusa o
 * que não sabe cobrar. Quando uma regra for aprovada, ela entra aqui — e só
 * aqui — sem mudar o formato do pedido.
 *
 * Nenhum desses campos carrega preço. O total continua saindo exclusivamente de
 * `PlanoPreco`, e campo financeiro no corpo continua recusado
 * (`campoFinanceiroNoCorpo`).
 */

export type ResultadoDasOpcoes =
  | { ok: true }
  | { ok: false; codigo: "cupom_invalido" | "adicional_indisponivel" | "parametros_invalidos" };

export interface CorpoDasOpcoes {
  cupom?: unknown;
  telasAdicionais?: unknown;
  servidorVip?: unknown;
  adicionais?: unknown;
}

export function validarOpcoesComerciais(corpo: CorpoDasOpcoes): ResultadoDasOpcoes {
  const { cupom, telasAdicionais, servidorVip, adicionais } = corpo;

  if (cupom !== undefined && cupom !== null) {
    if (typeof cupom !== "string" || cupom.length > 64) return { ok: false, codigo: "parametros_invalidos" };
    if (cupom.trim() !== "") return { ok: false, codigo: "cupom_invalido" };
  }

  if (telasAdicionais !== undefined && telasAdicionais !== null) {
    if (typeof telasAdicionais !== "number" || !Number.isInteger(telasAdicionais) || telasAdicionais < 0) {
      return { ok: false, codigo: "parametros_invalidos" };
    }
    if (telasAdicionais > 0) return { ok: false, codigo: "adicional_indisponivel" };
  }

  if (servidorVip !== undefined && servidorVip !== null) {
    if (typeof servidorVip !== "boolean") return { ok: false, codigo: "parametros_invalidos" };
    if (servidorVip) return { ok: false, codigo: "adicional_indisponivel" };
  }

  if (adicionais !== undefined && adicionais !== null) {
    if (!Array.isArray(adicionais)) return { ok: false, codigo: "parametros_invalidos" };
    if (adicionais.length > 0) return { ok: false, codigo: "adicional_indisponivel" };
  }

  return { ok: true };
}
