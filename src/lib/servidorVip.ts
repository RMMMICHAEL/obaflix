/**
 * Servidor VIP: o direito da conta e onde ele é aplicado.
 *
 * ## O direito
 *
 * `servidorVip` efetivo = `Plano.servidorVip` (incluso no plano) **ou** o
 * adicional comprado junto da assinatura vigente (`Assinatura.servidorVip`).
 * Quem resolve é `entitlements.ts`, a partir do banco. Nome de plano e campo do
 * cliente não entram.
 *
 * ## A aplicação
 *
 * `extractCineVs` — chamado por `/api/player/extract` e
 * `/api/player/fonte-nativa` — recebe o direito resolvido aqui. Com `false`,
 * vídeo `is_premium` não é listado, não é escolhido automaticamente e, pedido
 * por `videoId`, não é resolvido.
 *
 * ## Com `MONETIZACAO_ATIVA` desligada
 *
 * `undefined`: nenhum filtro, sem consultar nada — o mesmo bypass dos demais
 * direitos. Ligada, falha ao resolver vira `false` (fail-closed): não saber se a
 * conta tem VIP não libera o VIP.
 *
 * ## Oferta
 *
 * O direito existir não coloca o VIP na vitrine nem no checkout: isso continua
 * desligado até a oferta ser liberada (`SERVIDOR_VIP_NA_VITRINE`).
 */

import { entitlementsDoUsuario, type Entitlements } from "./entitlements";
import { monetizacaoAtiva } from "./playbackAuthorization";
import type { DireitoServidorVip } from "./servidorVipRegra";

export { videoPermitidoPorVip, type DireitoServidorVip } from "./servidorVipRegra";

export async function servidorVipDaConta(
  userId: string,
  opcoes: { ativa?: boolean; resolver?: (userId: string) => Promise<Entitlements> } = {},
): Promise<DireitoServidorVip> {
  const ativa = opcoes.ativa ?? monetizacaoAtiva();
  if (!ativa) return undefined;
  const resolver = opcoes.resolver ?? entitlementsDoUsuario;
  try {
    return (await resolver(userId)).direitos.servidorVip === true;
  } catch {
    return false;
  }
}
