export const STATUS_TERMINAIS_DO_PEDIDO = new Set([
  "PAGO", "EXPIRADO", "CANCELADO", "ESTORNADO", "REVISAO_MANUAL",
]);

export function deveFazerPolling(status: string) {
  return !STATUS_TERMINAIS_DO_PEDIDO.has(status);
}

// Nota: `qrCodeBase64` do provedor NÃO é uma imagem — na prática vem o payload
// EMV do PIX (o mesmo copia-e-cola). Por isso o QR é gerado no cliente a partir
// do copia-e-cola (checkout/page.tsx), e não a partir de um PNG do gateway.

export function acaoComercialDoPlano({
  compravel,
  planoAtual,
  assinaturaAtiva,
}: {
  compravel: boolean;
  planoAtual: boolean;
  assinaturaAtiva: boolean;
}) {
  if (!compravel) return { disponivel: false, rotulo: "Indisponível" };
  if (assinaturaAtiva && planoAtual) return { disponivel: true, rotulo: "Renovar" };
  if (assinaturaAtiva) return { disponivel: true, rotulo: "Alterar plano" };
  return { disponivel: true, rotulo: "Assinar" };
}

/**
 * O valor nunca faz parte do contrato enviado pelo navegador.
 *
 * O cliente envia só escolhas — plano, preço (que carrega a duração), dados do
 * pagador e cupom. O servidor resolve preço, valida cupom e adicionais e calcula
 * o total. Cupom vazio não é enviado.
 */
export function corpoCriarPedido(
  planoId: string | null,
  planoPrecoId: string | null,
  pagador: { nome: string; telefone: string; documento: string },
  opcoes: { cupom?: string; telasAdicionais?: number } = {},
) {
  const cupom = opcoes.cupom?.trim();
  const telas = opcoes.telasAdicionais;
  return {
    planoId, planoPrecoId, ...pagador,
    ...(cupom ? { cupom } : {}),
    ...(typeof telas === "number" && telas > 0 ? { telasAdicionais: telas } : {}),
  };
}

/** Texto da operação que o servidor decidiu. Informativo; o valor já veio calculado. */
export function descricaoDaOperacao(pedido: { operacao?: string; creditoCentavos?: number; iniciaEm?: string; moeda?: string }): string | null {
  const data = pedido.iniciaEm ? new Date(pedido.iniciaEm).toLocaleDateString("pt-BR") : null;
  const credito = typeof pedido.creditoCentavos === "number" && pedido.creditoCentavos > 0
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: pedido.moeda ?? "BRL" }).format(pedido.creditoCentavos / 100)
    : null;
  if (pedido.operacao === "renovacao") return data ? `Renovação: o novo período começa em ${data}, ao fim do atual.` : "Renovação do seu plano.";
  if (pedido.operacao === "downgrade") return data ? `Mudança de plano: começa em ${data}, quando terminar o período já pago.` : "Mudança de plano ao fim do período pago.";
  if (pedido.operacao === "upgrade") return credito ? `Upgrade imediato. Crédito do período não utilizado: ${credito}.` : "Upgrade imediato.";
  return null;
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
  if (codigo === "pagamento_em_revisao") return "Seu pagamento está em análise. Não faça outro pagamento para esta assinatura. Acompanhe o status por aqui.";
  if (codigo === "plano_indisponivel") return "Plano temporariamente indisponível para compra.";
  if (codigo === "cupom_invalido") return "Cupom inválido.";
  if (codigo === "adicional_indisponivel") return "Este adicional ainda não está disponível.";
  if (codigo === "telas_acima_do_limite") return "É possível contratar no máximo 2 telas adicionais.";
  if (codigo === "servidor_vip_ja_incluso") return "O servidor VIP já está incluso neste plano.";
  if (codigo === "credito_maior_que_compra") return "O crédito do seu plano atual é maior que esta compra. Escolha uma duração maior.";
  if (codigo === "duracao_invalida") return "Esta duração não está disponível.";
  if (codigo === "dados_do_pagador_invalidos") return "Confira nome, telefone e CPF/CNPJ.";
  return "Não foi possível iniciar o pagamento.";
}
