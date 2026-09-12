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

export function mensagemErroCheckout(codigo?: string) {
  if (codigo === "assinatura_ativa") return "Você já possui uma assinatura ativa.";
  if (codigo === "plano_indisponivel") return "Plano temporariamente indisponível para compra.";
  return "Não foi possível iniciar o pagamento.";
}
