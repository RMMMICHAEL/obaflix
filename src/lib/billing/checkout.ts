export const STATUS_TERMINAIS_DO_PEDIDO = new Set([
  "PAGO", "EXPIRADO", "CANCELADO", "ESTORNADO", "REVISAO_MANUAL",
]);

export function deveFazerPolling(status: string) {
  return !STATUS_TERMINAIS_DO_PEDIDO.has(status);
}

/** O valor nunca faz parte do contrato enviado pelo navegador. */
export function corpoCriarPedido(planoId: string | null, planoPrecoId: string | null, pagador: { nome: string; telefone: string; documento: string }) {
  return { planoId, planoPrecoId, ...pagador };
}

/**
 * Retorno depois de login ou cadastro: só caminho interno do próprio site.
 * Mesma regra que a página de login já aplicava — `//host` e `/\host` são
 * redirecionamento aberto disfarçado de caminho.
 */
export function caminhoInternoSeguro(valor: string | null | undefined, padrao = "/"): string {
  return typeof valor === "string" && valor.startsWith("/") && !valor.startsWith("//") && !valor.includes("\\")
    ? valor
    : padrao;
}

/** Login que volta a este checkout, com plano e preço preservados. */
export function destinoDoLoginDoCheckout(query: string): string {
  const destino = "/checkout" + (query ? `?${query}` : "");
  return `/login?callbackUrl=${encodeURIComponent(destino)}`;
}

/** O plano que a TV mandou destacar em `/planos?plano=<id>`. Só id bem formado. */
export function planoEscolhidoDaUrl(search: string): string | null {
  const valor = new URLSearchParams(search).get("plano");
  return valor && /^[a-z0-9_-]{1,32}$/.test(valor) ? valor : null;
}

export function mensagemErroCheckout(codigo?: string) {
  if (codigo === "assinatura_ativa") return "Você já possui uma assinatura ativa.";
  if (codigo === "plano_indisponivel") return "Plano temporariamente indisponível para compra.";
  return "Não foi possível iniciar o pagamento.";
}
