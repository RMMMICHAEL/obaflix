/**
 * O que a rota aceita do cliente, e o que ela recusa.
 *
 * Vive fora do arquivo de rota por dois motivos. O primeiro é testabilidade: um
 * módulo de rota do App Router só pode exportar os verbos HTTP e a configuração
 * dela, então nada aqui seria alcançável por um teste se ficasse lá. O segundo é
 * que esta é a **fronteira de confiança** — o ponto exato em que texto vindo da
 * internet vira dado usado numa cobrança — e uma fronteira merece um arquivo com
 * nome, não um punhado de funções soltas no meio de um handler.
 */

import type { DadosDoPagador } from "./pedidos";

/** Só dígitos. Aceita `"(11) 99999-9999"` e devolve `"11999999999"`. */
export function soDigitos(valor: unknown): string {
  return typeof valor === "string" ? valor.replace(/\D/g, "") : "";
}

/**
 * Um identificador comercial (`planoId`, `planoPrecoId`), ou `null`.
 *
 * O formato cobre os dois que o schema usa: o slug de `Plano.id` e o cuid de
 * `PlanoPreco.id`. O teto de 64 existe para o valor não virar chave de consulta
 * de tamanho arbitrário — o `readJsonBody` já limita o corpo inteiro, e este
 * limita o campo.
 */
export function identificadorComercial(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(limpo) ? limpo : null;
}

/** O que a conta autenticada fornece. Nunca vem do corpo. */
export interface ContaDoPagador {
  nome: string | null;
  email: string;
}

/** O que o cliente pode enviar sobre o pagador. Nada aqui influencia valor. */
export interface CorpoDoPagador {
  documento?: unknown;
  telefone?: unknown;
  nome?: unknown;
}

/**
 * Monta o pagador exigido pela Blackcat, ou devolve `null`.
 *
 * A divisão entre conta e corpo **é** a fronteira de confiança:
 *
 *   - `email` **sempre** da conta autenticada. Nunca do corpo: deixar o cliente
 *     escolher o e-mail da cobrança permitiria emitir fatura em nome de outra
 *     pessoa a partir da própria sessão;
 *   - `nome` da conta quando existir. `User.nome` é nullable — o cadastro por
 *     e-mail aceita conta sem nome — e a Blackcat exige o campo, então o corpo é
 *     aceito **como fallback**. É dado do pagador sem fonte no servidor, que é
 *     exatamente a exceção prevista, e não influencia valor nem duração;
 *   - `telefone` e `documento` sempre do corpo: não existem no nosso banco.
 *
 * **Nada disto é persistido.** Atravessa o processo até a requisição ao provedor
 * e morre ali — nem `PedidoPagamento`, nem log, nem auditoria.
 *
 * O tipo do documento sai do **comprimento**, e não de um campo do cliente: 11
 * dígitos é CPF, 14 é CNPJ. Deixar o cliente declarar o tipo permitiria enviar
 * um par (número, tipo) incoerente, que a Blackcat recusaria com um erro que não
 * nos diz nada de útil e que o usuário não teria como corrigir.
 */
export function montarPagador(
  conta: ContaDoPagador,
  corpo: CorpoDoPagador,
): DadosDoPagador | null {
  const doCorpo = typeof corpo.nome === "string" ? corpo.nome.trim() : "";
  const nome = (conta.nome?.trim() || doCorpo).slice(0, 80);
  if (nome.length < 2) return null;

  const email = conta.email.trim();
  if (!email) return null;

  // BR: 10 dígitos (fixo com DDD) ou 11 (celular com DDD).
  const telefone = soDigitos(corpo.telefone);
  if (telefone.length < 10 || telefone.length > 11) return null;

  const numero = soDigitos(corpo.documento);
  const tipo = numero.length === 11 ? "cpf" : numero.length === 14 ? "cnpj" : null;
  if (!tipo) return null;

  return { nome, email, telefone, documento: { numero, tipo } };
}
