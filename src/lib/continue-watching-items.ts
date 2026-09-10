type WatchHistoryItem = {
  conteudoId: string;
  conteudoTipo: string;
};

/**
 * Mantém a entrada mais recente de cada conteúdo. A consulta que a alimenta
 * já vem em `updatedAt DESC`, portanto a primeira ocorrência é a que deve
 * representar a série em "Continuar assistindo".
 */
export function latestItemPerContent<T extends WatchHistoryItem>(history: T[]): T[] {
  const seen = new Set<string>();

  return history.filter((item) => {
    const key = `${item.conteudoTipo}:${item.conteudoId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
