/**
 * Escrita em lote de episódios pela coordenada (serieId, temporada, numeroEp).
 *
 * Por que existe: os produtores em lote (SuperFlix, WebCine script, imports)
 * usavam `createMany({ skipDuplicates: true })`. Isso só pula linha quando o
 * banco recusa por constraint — e o índice único da coordenada nunca foi
 * criado em produção. Resultado: o mesmo episódio com IDs diferentes
 * (`wc_ep_560647` do WebCine, `sf_…-t1e1` do SuperFlix) virava duas linhas.
 *
 * Aqui a identidade é a coordenada, nunca o ID externo:
 *   - coordenada nova → INSERT (o ID do produtor só vale na criação);
 *   - coordenada existente → nunca INSERT; só completa campos vazios da linha
 *     existente (merge conservador: valor válido nunca é trocado nem apagado);
 *   - coordenada repetida dentro do mesmo lote → uma linha só.
 *
 * Com o índice único aplicado, `skipDuplicates` passa a cobrir também a corrida
 * entre dois produtores simultâneos.
 */

export type EpisodeRow = {
  id: string;
  serieId: string;
  temporada: number;
  numeroEp: number;
  titulo?: string | null;
  thumbnail?: string | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  createdAt?: Date;
};

export type ExistingEpisode = {
  id: string;
  serieId: string;
  temporada: number;
  numeroEp: number;
  titulo: string | null;
  thumbnail: string | null;
  urlDub: string | null;
  urlLeg: string | null;
};

export type EpisodeWritePlan = {
  create: EpisodeRow[];
  fill: Array<{ id: string; data: Partial<Pick<EpisodeRow, "titulo" | "thumbnail" | "urlDub" | "urlLeg">> }>;
  /** Linhas recebidas que não viraram INSERT (coordenada existente ou repetida no lote). */
  skipped: number;
};

const MERGEABLE = ["titulo", "thumbnail", "urlDub", "urlLeg"] as const;

export const episodeCoordinate = (row: { serieId: string; temporada: number; numeroEp: number }) =>
  `${row.serieId}\u0000${row.temporada}\u0000${row.numeroEp}`;

const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Decide o que gravar, sem banco. `existing` deve vir ordenado de forma
 * determinística (createdAt, id): com duplicatas antigas, a primeira linha de
 * cada coordenada é a que recebe o merge.
 */
export function planEpisodeWrites(existing: ExistingEpisode[], incoming: EpisodeRow[]): EpisodeWritePlan {
  const current = new Map<string, ExistingEpisode>();
  for (const row of existing) {
    const key = episodeCoordinate(row);
    if (!current.has(key)) current.set(key, row);
  }
  const creating = new Map<string, EpisodeRow>();
  const fills = new Map<string, EpisodeWritePlan["fill"][number]["data"]>();
  let skipped = 0;

  for (const row of incoming) {
    const key = episodeCoordinate(row);
    const target = current.get(key);
    if (target) {
      skipped++;
      const data = fills.get(target.id) ?? {};
      for (const field of MERGEABLE) {
        if (!filled(target[field]) && data[field] === undefined && filled(row[field])) data[field] = row[field];
      }
      if (Object.keys(data).length > 0) fills.set(target.id, data);
      continue;
    }
    const pending = creating.get(key);
    if (pending) {
      skipped++;
      for (const field of MERGEABLE) {
        if (!filled(pending[field]) && filled(row[field])) pending[field] = row[field];
      }
      continue;
    }
    creating.set(key, { ...row });
  }

  return {
    create: [...creating.values()],
    fill: [...fills.entries()].map(([id, data]) => ({ id, data })),
    skipped,
  };
}

type EpisodeDb = {
  episodio: {
    findMany(args: any): Promise<ExistingEpisode[]>;
    update(args: any): Promise<unknown>;
    createMany(args: any): Promise<{ count: number }>;
  };
};

export type EpisodeWriteResult = { created: number; filled: number; skipped: number };

const BATCH = 200;

/** Grava pela coordenada. Uma leitura indexada extra por lote de 200. */
export async function writeEpisodesByCoordinate(db: EpisodeDb, rows: EpisodeRow[]): Promise<EpisodeWriteResult> {
  const result: EpisodeWriteResult = { created: 0, filled: 0, skipped: 0 };
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const coords = [...new Map(batch.map((r) => [episodeCoordinate(r), { serieId: r.serieId, temporada: r.temporada, numeroEp: r.numeroEp }])).values()];
    const existing = await db.episodio.findMany({
      where: { OR: coords },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, serieId: true, temporada: true, numeroEp: true, titulo: true, thumbnail: true, urlDub: true, urlLeg: true },
    });
    const plan = planEpisodeWrites(existing, batch);
    for (const { id, data } of plan.fill) {
      await db.episodio.update({ where: { id }, data });
      result.filled++;
    }
    if (plan.create.length > 0) {
      const inserted = await db.episodio.createMany({ data: plan.create, skipDuplicates: true });
      result.created += inserted.count;
      result.skipped += plan.create.length - inserted.count;
    }
    result.skipped += plan.skipped;
  }
  return result;
}
