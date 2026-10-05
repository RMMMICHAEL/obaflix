/** Segundos inteiros restantes da duração homologada do anúncio Electron. */
export function segundosRestantesAnuncio(prazo: number, agora = Date.now()): number {
  return Math.max(0, Math.ceil((prazo - agora) / 1000));
}
