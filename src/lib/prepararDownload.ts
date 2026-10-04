export const PREPARACAO_DOWNLOAD_TIMEOUT_MS = 12_000;

/** Uma única verificação rápida da mídia selecionada; não resolve nem enumera fontes. */
export async function verificarDownloadAtual<T>(
  midia: T | null,
  verificar: (midia: T) => Promise<boolean>,
  timeoutMs = PREPARACAO_DOWNLOAD_TIMEOUT_MS,
): Promise<boolean> {
  if (!midia) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => verificar(midia)),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Consome rejeições de play() tanto nativo quanto JW, inclusive após teardown. */
export function controlarMidia(acao: () => unknown, absorver = true): void {
  if (!absorver) { acao(); return; }
  try { Promise.resolve(acao()).catch(() => {}); } catch { /* player já removido */ }
}
