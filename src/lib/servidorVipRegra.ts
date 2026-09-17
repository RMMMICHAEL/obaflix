/**
 * A regra do servidor VIP, pura — sem banco, sem Redis.
 *
 * Separada de `servidorVip.ts` para `cinevs.ts` poder aplicá-la sem carregar
 * entitlements e Prisma junto do extrator.
 *
 * "VIP" é o vídeo que o provedor Webcine marca `is_premium`: a única marca
 * confiável, lida no servidor.
 */

/** `true`: tem. `false`: não tem, filtra. `undefined`: enforcement desligado, não filtra. */
export type DireitoServidorVip = boolean | undefined;

/** Este vídeo pode ser listado e resolvido para esta conta? */
export function videoPermitidoPorVip(ehPremium: boolean, direito: DireitoServidorVip): boolean {
  return !ehPremium || direito !== false;
}
