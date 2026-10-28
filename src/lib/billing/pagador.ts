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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * E-mail de quem compra Cortes sem login, normalizado (trim + minúsculas) como
 * no cadastro: é a chave que cria ou vincula a conta na confirmação. Informar o
 * e-mail não dá acesso a nada — só identifica a cobrança.
 */
export function emailDoComprador(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const email = valor.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** Idade mínima para comprar: quem paga contrata a assinatura. */
export const IDADE_MINIMA_COMPRA = 18;

/**
 * Data de nascimento de quem compra sem login (`AAAA-MM-DD`), como data UTC sem
 * hora, ou `null`: formato inválido, data inexistente (31/02), futura, acima de
 * 120 anos ou abaixo da idade mínima.
 */
export function nascimentoDoComprador(valor: unknown, agora: Date = new Date()): Date | null {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) return null;
  const [a, m, d] = valor.trim().split("-").map(Number);
  const data = new Date(Date.UTC(a, m - 1, d));
  if (data.getUTCFullYear() !== a || data.getUTCMonth() !== m - 1 || data.getUTCDate() !== d) return null;
  const idade = agora.getUTCFullYear() - a - (agora.getUTCMonth() < m - 1 || (agora.getUTCMonth() === m - 1 && agora.getUTCDate() < d) ? 1 : 0);
  return idade >= IDADE_MINIMA_COMPRA && idade <= 120 ? data : null;
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
  opcoes: { preferirNomeInformado?: boolean } = {},
): DadosDoPagador | null {
  const doCorpo = typeof corpo.nome === "string" ? corpo.nome.trim() : "";
  const nome = ((opcoes.preferirNomeInformado ? (doCorpo || conta.nome?.trim()) : (conta.nome?.trim() || doCorpo)) || "").slice(0, 80);
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

/** Validação de CPF com dígitos verificadores; evita chamar o gateway sem chance de sucesso. */
export function cpfValido(valor: unknown): boolean {
  const d = soDigitos(valor);
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (base: string, pesoInicial: number) => {
    const soma = [...base].reduce((s, c, i) => s + Number(c) * (pesoInicial - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return dv(d.slice(0, 9), 10) === Number(d[9]) && dv(d.slice(0, 10), 11) === Number(d[10]);
}

/** CNPJ com dígitos verificadores, conservado para compradores empresariais legados. */
export function cnpjValido(valor: unknown): boolean {
  const d = soDigitos(valor);
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const digito = (s: string, pesos: number[]) => {
    const resto = [...s].reduce((acc, c, i) => acc + Number(c) * pesos[i], 0) % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return digito(d.slice(0, 12), [5,4,3,2,9,8,7,6,5,4,3,2]) === Number(d[12]) &&
    digito(d.slice(0, 13), [6,5,4,3,2,9,8,7,6,5,4,3,2]) === Number(d[13]);
}

export function nomeCompletoValido(valor: unknown): boolean {
  if (typeof valor !== "string") return false;
  const p = valor.trim().replace(/\s+/g, " ");
  return p.length >= 5 && p.length <= 80 && /^[\p{L}][\p{L}'’. -]*[\p{L}]$/u.test(p) &&
    p.split(" ").filter(s => s.replace(/[^\p{L}]/gu, "").length >= 2).length >= 2;
}

export function telefoneBrasileiroValido(valor: unknown): boolean {
  const d = soDigitos(valor);
  if (!/^\d{10,11}$/.test(d)) return false;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99 || d[2] === "0") return false;
  // Não inventa obrigatoriedade de celular: números fixos com DDD continuam possíveis.
  return true;
}

export function pagadorCaktoValido(pagador: DadosDoPagador): boolean {
  const numero = pagador.documento.numero;
  return nomeCompletoValido(pagador.nome) && telefoneBrasileiroValido(pagador.telefone) &&
    (pagador.documento.tipo === "cpf" ? cpfValido(numero) : cnpjValido(numero));
}
