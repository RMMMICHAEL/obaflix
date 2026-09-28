/** Identidade externa confiável para agregação entre provedores. */
export function normalizeTmdbId(value: unknown): string | null {
  const id = String(value ?? "").trim();
  return id && id !== "0" ? id : null;
}

/**
 * Acrescenta uma URL de provedor sem apagar espelhos já existentes.
 *
 * As colunas antigas armazenam uma lista separada por vírgulas. A função não
 * tenta inferir identidade por título e preserva a ordem dos provedores que já
 * estavam disponíveis.
 */
export function mergeProviderUrl(current: string | null | undefined, incoming: string): string {
  const urls = (current ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.includes(incoming)) urls.push(incoming);
  return urls.join(",");
}
