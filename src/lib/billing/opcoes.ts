/**
 * Validação de formato das opções do pedido: cupom, telas adicionais, VIP avulso.
 *
 * Aqui só forma e o que está indisponível por decisão. Limite de telas, preço e
 * disponibilidade do VIP avulso são decididos em `calcularTotal`
 * (`precificacao.ts`), com os preços do banco.
 *
 * - **Cupom:** indisponível nesta fase. Não existe catálogo nem regra de
 *   desconto; qualquer cupom informado é recusado com `cupom_invalido`, e o pedido
 *   não é criado. Desconto fictício não é aplicado.
 * - **`adicionais` genérico:** não faz parte do contrato. As opções têm campo
 *   próprio (`telasAdicionais`, `servidorVip`); um array de adicionais é recusado.
 *
 * Nenhum desses campos carrega preço. O total sai do servidor; campo financeiro
 * no corpo continua recusado (`campoFinanceiroNoCorpo`).
 */

export type ResultadoDasOpcoes =
  | { ok: true; telasAdicionais: number; servidorVip: boolean }
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

  let telas = 0;
  if (telasAdicionais !== undefined && telasAdicionais !== null) {
    if (typeof telasAdicionais !== "number" || !Number.isInteger(telasAdicionais) || telasAdicionais < 0 || telasAdicionais > 99) {
      return { ok: false, codigo: "parametros_invalidos" };
    }
    telas = telasAdicionais;
  }

  let vip = false;
  if (servidorVip !== undefined && servidorVip !== null) {
    if (typeof servidorVip !== "boolean") return { ok: false, codigo: "parametros_invalidos" };
    vip = servidorVip;
  }

  if (adicionais !== undefined && adicionais !== null) {
    if (!Array.isArray(adicionais)) return { ok: false, codigo: "parametros_invalidos" };
    if (adicionais.length > 0) return { ok: false, codigo: "adicional_indisponivel" };
  }

  return { ok: true, telasAdicionais: telas, servidorVip: vip };
}
