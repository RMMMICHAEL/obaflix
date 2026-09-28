/**
 * Destino dos produtores HTTP de catálogo (scripts/sync-app.ts e, em JS
 * próprio, scripts/tampermonkey-sync.js).
 *
 * OBAFLIX_SYNC_DESTINO:
 *   (ausente)  → automático: `integracao` se CATALOG_SYNC_TOKEN estiver
 *              configurado; senão `legado` com aviso de descontinuação.
 *   integracao → /api/integracoes/catalogo/* com Authorization: Bearer
 *              CATALOG_SYNC_TOKEN. Caminho final. Só catálogo; o token não
 *              abre nada humano.
 *   legado     → /api/admin/{filme,serie,episodio/bulk} com x-admin-token
 *              (ADMIN_SECRET_TOKEN). Transição: só funciona no projeto
 *              público com o cutover desligado; ligado, responde 404.
 *
 * O automático não troca de modo por conta própria depois de escolher: sem
 * CATALOG_SYNC_TOKEN local nada muda em relação a hoje. Em modo integração o corpo é
 * "podado": campo null/""/ausente não é enviado, porque na camada de escrita
 * `null` significa "limpar" e a origem manda null quando simplesmente não tem
 * o dado. Também não envia `tipo: "serie"` (o padrão), para não rebaixar um
 * anime/desenho já classificado; na criação o padrão continua "serie".
 */
export type CatalogDestinoModo = "legado" | "integracao";

export type CatalogDestino = {
  modo: CatalogDestinoModo;
  /** Avisos para o operador (ex.: legado em uso). Nunca contém o token. */
  avisos: string[];
  baseUrl: string;
  headers: Record<string, string>;
  paths: { filme: string; serie: string; episodiosBulk: string; consulta: string | null };
  /** Corpo pronto para envio no modo atual. */
  body(kind: "filme" | "serie" | "episodios", payload: Record<string, unknown>): Record<string, unknown>;
};

export const DEFAULT_OBAFLIX_URL = "https://obaflix.vercel.app";

export function pruneCatalogPayload(kind: "filme" | "serie" | "episodios", payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (kind === "serie" && key === "tipo" && value === "serie") continue;
    if (kind === "episodios" && key === "episodios" && Array.isArray(value)) {
      out.episodios = value.map((ep) => (ep && typeof ep === "object" ? pruneCatalogPayload("filme", ep as Record<string, unknown>) : ep));
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function resolveCatalogDestino(env: Record<string, string | undefined> = process.env): CatalogDestino {
  const explicit = env.OBAFLIX_SYNC_DESTINO?.trim().toLowerCase();
  if (explicit && explicit !== "legado" && explicit !== "integracao") throw new Error(`OBAFLIX_SYNC_DESTINO inválido: use "legado" ou "integracao"`);
  const raw = explicit || ((env.CATALOG_SYNC_TOKEN?.length ?? 0) >= 32 ? "integracao" : "legado");
  const baseUrl = (env.OBAFLIX_URL ?? DEFAULT_OBAFLIX_URL).replace(/\/+$/, "");
  if (raw === "integracao") {
    const token = env.CATALOG_SYNC_TOKEN;
    if (!token || token.length < 32) throw new Error("OBAFLIX_SYNC_DESTINO=integracao exige CATALOG_SYNC_TOKEN (mínimo 32 caracteres)");
    return {
      modo: "integracao",
      avisos: [],
      baseUrl,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      paths: {
        filme: "/api/integracoes/catalogo/filme",
        serie: "/api/integracoes/catalogo/serie",
        episodiosBulk: "/api/integracoes/catalogo/episodios/bulk",
        consulta: "/api/integracoes/catalogo/consulta",
      },
      body: (kind, payload) => pruneCatalogPayload(kind, payload),
    };
  }
  const token = env.ADMIN_SECRET_TOKEN;
  if (!token) throw new Error("Sem credencial de catálogo: configure CATALOG_SYNC_TOKEN (integração) ou, na transição, ADMIN_SECRET_TOKEN com OBAFLIX_SYNC_DESTINO=legado");
  return {
    modo: "legado",
    avisos: ["modo legado (/api/admin + x-admin-token) está em descontinuação: configure CATALOG_SYNC_TOKEN; após o cutover o legado responde 404"],
    baseUrl,
    headers: { "Content-Type": "application/json", "x-admin-token": token },
    paths: { filme: "/api/admin/filme", serie: "/api/admin/serie", episodiosBulk: "/api/admin/episodio/bulk", consulta: null },
    body: (_kind, payload) => payload,
  };
}

/** Episódios gravados, nos dois formatos de resposta do bulk. */
export function episodiosGravados(response: unknown): number {
  const r = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  if (typeof r.ok === "number") return r.ok; // legado: { ok: <quantidade>, errors }
  return (Number(r.added) || 0) + (Number(r.updated) || 0); // integração: { ok: bool, added, updated }
}
