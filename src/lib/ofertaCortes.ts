/**
 * Apresentação "De/Por" da vitrine Cortes. O valor de referência vem só de
 * `PlanoPreco.precoOriginalCentavos`; sem ele (ou se não for maior que o atual)
 * não há desconto a mostrar. Nunca calcula percentual nem inventa referência.
 */
export function ofertaDePor(precoCentavos: number, original: unknown): { deCentavos: number; economiaCentavos: number } | null {
  if (typeof original !== "number" || !Number.isInteger(original) || original <= precoCentavos || precoCentavos <= 0) return null;
  return { deCentavos: original, economiaCentavos: original - precoCentavos };
}
