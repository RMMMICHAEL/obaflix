/**
 * Servidor VIP: o direito e onde ele é aplicado.
 *
 * ## Classificação
 *
 * "VIP" é o vídeo que o provedor Webcine marca `is_premium`. É a única marca
 * confiável: vem da API do provedor, lida no servidor (`src/lib/cinevs.ts`), e
 * não de rótulo de interface.
 *
 * ## Aplicação
 *
 * O filtro vive dentro de `extractCineVs`, que é chamado pelos dois caminhos que
 * listam ou resolvem esses vídeos — `/api/player/extract` e
 * `/api/player/fonte-nativa`. Com `servidorVip === false`, vídeo premium não é
 * listado, não é escolhido automaticamente e, pedido por `videoId`, não é
 * resolvido.
 *
 * ## Estado: preparado e desligado
 *
 * O direito `servidorVip` **não existe no schema** (proposta em
 * `docs/planos-comerciais.md`; migration não autorizada). Sem ele não há como
 * saber quem pode, e cortar premium de todos tiraria de Plus e Premium o que eles
 * já recebem. Então `servidorVipDaConta` devolve `undefined` — "não modelado" —
 * e o filtro não age: o comportamento de hoje, em que vídeo premium chega a
 * qualquer conta, continua. Isso é bloqueio de publicação da oferta de VIP, e não
 * proteção.
 *
 * Quando a coluna existir, só `servidorVipDaConta` muda: passa a devolver
 * `entitlements.direitos.servidorVip === true`, atrás de `MONETIZACAO_ATIVA`.
 */

/** `true`: tem. `false`: não tem, filtra. `undefined`: direito não modelado, não filtra. */
export type DireitoServidorVip = boolean | undefined;

export async function servidorVipDaConta(_userId: string): Promise<DireitoServidorVip> {
  return undefined;
}

/** Este vídeo pode ser listado e resolvido para esta conta? */
export function videoPermitidoPorVip(ehPremium: boolean, direito: DireitoServidorVip): boolean {
  return !ehPremium || direito !== false;
}
