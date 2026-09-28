/**
 * Tabela `episodio` em memória com a semântica que catalog-write usa:
 * busca pela coordenada (findFirst), update por id e create. O Map é chaveado
 * por `serieId|temporada|numeroEp` para os testes consultarem direto, e um
 * create numa coordenada ocupada falha como o índice único faria (P2002).
 */
export function memoryEpisodeTable(rows: Map<string, any>) {
  const key = (r: any) => `${r.serieId}|${r.temporada}|${r.numeroEp}`;
  const byId = (id: string) => [...rows.values()].find((r) => r.id === id);
  return {
    findFirst: async ({ where }: any) => rows.get(key(where)) ?? null,
    update: async ({ where, data }: any) => {
      const row = byId(where.id);
      if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
      Object.assign(row, data);
      return row;
    },
    create: async ({ data }: any) => {
      if (rows.has(key(data)) || byId(data.id)) throw Object.assign(new Error("unique"), { code: "P2002" });
      rows.set(key(data), { ...data });
      return { id: data.id };
    },
  };
}
