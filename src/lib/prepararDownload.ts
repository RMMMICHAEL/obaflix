/** Ordem determinística: mídia atual, depois fontes da mesma sessão. Sem anúncio. */
export async function encontrarMidiaCompativel<T, F>(atual: T | null, fontes: F[], portas: {
  ativa: () => boolean;
  verificar: (midia: T) => Promise<boolean>;
  resolver: (fonte: F) => Promise<T | null>;
}): Promise<T | null> {
  const testar = async (midia: T | null) => {
    if (!midia || !portas.ativa()) return null;
    try { return await portas.verificar(midia) && portas.ativa() ? midia : null; }
    catch { return null; }
  };
  const inicial = await testar(atual);
  if (inicial) return inicial;
  for (const fonte of fontes) {
    if (!portas.ativa()) return null;
    try {
      const candidata = await testar(await portas.resolver(fonte));
      if (candidata) return candidata;
    } catch { /* Falha isolada não encerra a busca. Nunca retornar erro técnico. */ }
  }
  return null;
}

/** Consome rejeições de play() tanto nativo quanto JW, inclusive após teardown. */
export function controlarMidia(acao: () => unknown, absorver = true): void {
  if (!absorver) { acao(); return; }
  try { Promise.resolve(acao()).catch(() => {}); } catch { /* player já removido */ }
}
