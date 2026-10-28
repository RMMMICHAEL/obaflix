import { soDigitos } from "./pagador";

type Campo = "cpf" | "telefone";

export function mascararCheckout(
  campo: Campo,
  entrada: string,
  cursor = entrada.length,
  tipoEdicao = "",
  anterior = "",
): { valor: string; cursor: number } {
  let digitos = soDigitos(entrada);
  let antes = soDigitos(entrada.slice(0, cursor)).length;
  // Não confundir o DDD 55 de um número nacional com o código do país.
  if (campo === "telefone" && (entrada.trimStart().startsWith("+55") || (digitos.length > 11 && digitos.startsWith("55") && !entrada.trimStart().startsWith("(")))) {
    digitos = digitos.slice(2);
    antes = Math.max(0, antes - 2);
  }
  if (digitos === soDigitos(anterior) && (tipoEdicao === "deleteContentBackward" || tipoEdicao === "deleteContentForward")) {
    const indice = tipoEdicao === "deleteContentBackward" ? antes - 1 : antes;
    if (indice >= 0 && indice < digitos.length) {
      digitos = digitos.slice(0, indice) + digitos.slice(indice + 1);
      if (tipoEdicao === "deleteContentBackward") antes--;
    }
  }
  digitos = digitos.slice(0, 11);
  antes = Math.min(antes, digitos.length);
  let valor = "";
  if (campo === "cpf") {
    for (let i = 0; i < digitos.length; i++) {
      valor += digitos[i];
      if (i === 2 || i === 5) valor += ".";
      if (i === 8) valor += "-";
    }
  } else if (digitos) {
    valor = "(" + digitos.slice(0, 2);
    if (digitos.length >= 2) valor += ") ";
    const grupo = digitos.length === 11 ? 5 : 4;
    valor += digitos.slice(2, 2 + grupo);
    if (digitos.length >= 2 + grupo) valor += "-";
    valor += digitos.slice(2 + grupo);
  }
  let posicao = 0, vistos = 0;
  while (posicao < valor.length && vistos < antes) {
    if (/\d/.test(valor[posicao])) vistos++;
    posicao++;
  }
  // Avança a pontuação automática, preservando a posição lógica entre dígitos.
  if (cursor > 0) while (posicao < valor.length && /\D/.test(valor[posicao])) posicao++;
  return { valor, cursor: posicao };
}
