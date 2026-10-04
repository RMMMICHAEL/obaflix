/** Uma única verificação da mídia selecionada; os timeouts de rede/FFmpeg pertencem ao IPC. */
export async function verificarDownloadAtual<T>(
  midia: T | null,
  verificar: (midia: T) => Promise<boolean>,
): Promise<boolean> {
  if (!midia) return false;
  try {
    return await verificar(midia);
  } catch {
    return false;
  }
}

/** Consome rejeições de play() tanto nativo quanto JW, inclusive após teardown. */
export function controlarMidia(acao: () => unknown, absorver = true): void {
  if (!absorver) { acao(); return; }
  try { Promise.resolve(acao()).catch(() => {}); } catch { /* player já removido */ }
}
