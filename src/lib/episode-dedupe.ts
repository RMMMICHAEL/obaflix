/**
 * Deduplicação de episódios pela coordenada (serieId, temporada, numeroEp).
 *
 * Lógica pura + execução sobre um cliente com a forma do Prisma, para o mesmo
 * código rodar no script (`scripts/dedupe-episodios.ts`) e nos testes com
 * banco em memória. Nada aqui roda sozinho: o padrão do script é dry-run.
 *
 * Canônico de cada grupo, em ordem de desempate:
 *   1. linha referenciada por WatchHistory (mais referências primeiro);
 *   2. mais metadata válida (urlDub, urlLeg, título real, thumbnail);
 *   3. ID no padrão atual `<serieId>-t<T>e<E>`;
 *   4. createdAt mais antigo;
 *   5. id (ordem lexicográfica).
 *
 * Antes de remover uma duplicata: completa campos vazios do canônico, soma os
 * espelhos de URL (lista separada por vírgula) sem perder nenhum, e move o
 * WatchHistory. Valor válido nunca é trocado por null.
 */
import { mergeProviderUrl } from "@/lib/catalog-ingest";

export type DedupeEpisode = {
  id: string;
  serieId: string;
  temporada: number;
  numeroEp: number;
  titulo: string | null;
  thumbnail: string | null;
  urlDub: string | null;
  urlLeg: string | null;
  createdAt: Date;
};

export type DedupeWatch = {
  id: string;
  userId: string;
  conteudoId: string;
  episodioId: string | null;
  progressoSeg: number;
  concluido: boolean;
  updatedAt: Date;
};

export type Coordinate = { serieId: string; temporada: number; numeroEp: number };

export type GroupPlan = {
  coordinate: Coordinate;
  ids: string[];
  canonicalId: string;
  removeIds: string[];
  /** Campos gravados no canônico (só preenchimento e soma de espelhos). */
  merge: Partial<Pick<DedupeEpisode, "titulo" | "thumbnail" | "urlDub" | "urlLeg">>;
  /** WatchHistory que só troca episodioId para o canônico. */
  watchMove: string[];
  /** WatchHistory apagado por colidir com outro do mesmo usuário/conteúdo (fica o mais recente). */
  watchDrop: string[];
  /** WatchHistory que sobrevive a uma colisão e herda `concluido`. */
  watchMarkDone: string[];
  conflicts: string[];
};

const PLACEHOLDER_TITLE = /^\s*epis[oó]dio\s+\d+\s*$/i;
const filled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const realTitle = (v: unknown): v is string => filled(v) && !PLACEHOLDER_TITLE.test(v);

export const preferredEpisodeId = (c: Coordinate) => `${c.serieId}-t${c.temporada}e${c.numeroEp}`;

function metadataScore(ep: DedupeEpisode): number {
  return Number(filled(ep.urlDub)) + Number(filled(ep.urlLeg)) + Number(realTitle(ep.titulo)) + Number(filled(ep.thumbnail));
}

/** Ordena do melhor candidato a canônico para o pior. Determinístico. */
export function rankCandidates(group: DedupeEpisode[], refs: Map<string, number>): DedupeEpisode[] {
  return [...group].sort((a, b) =>
    (refs.get(b.id) ?? 0) - (refs.get(a.id) ?? 0)
    || metadataScore(b) - metadataScore(a)
    || Number(b.id === preferredEpisodeId(b)) - Number(a.id === preferredEpisodeId(a))
    || a.createdAt.getTime() - b.createdAt.getTime()
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const splitUrls = (v: string | null) => (v ?? "").split(",").map((u) => u.trim()).filter(Boolean);

export function planGroup(group: DedupeEpisode[], watch: DedupeWatch[]): GroupPlan {
  if (group.length < 2) throw new Error("grupo sem duplicata");
  const coordinate = { serieId: group[0].serieId, temporada: group[0].temporada, numeroEp: group[0].numeroEp };
  for (const ep of group) {
    if (ep.serieId !== coordinate.serieId || ep.temporada !== coordinate.temporada || ep.numeroEp !== coordinate.numeroEp) {
      throw new Error("grupo mistura coordenadas");
    }
  }
  const refs = new Map<string, number>();
  for (const w of watch) if (w.episodioId) refs.set(w.episodioId, (refs.get(w.episodioId) ?? 0) + 1);

  const ranked = rankCandidates(group, refs);
  const canonical = ranked[0];
  const others = ranked.slice(1);
  const merge: GroupPlan["merge"] = {};
  const conflicts: string[] = [];

  // Texto: completa o que falta (título placeholder conta como faltando).
  if (!realTitle(canonical.titulo)) {
    const t = others.find((o) => realTitle(o.titulo))?.titulo;
    if (t) merge.titulo = t;
    else if (!filled(canonical.titulo)) {
      const any = others.find((o) => filled(o.titulo))?.titulo;
      if (any) merge.titulo = any;
    }
  }
  if (!filled(canonical.thumbnail)) {
    const t = others.find((o) => filled(o.thumbnail))?.thumbnail;
    if (t) merge.thumbnail = t;
  }
  const finalTitle = merge.titulo ?? canonical.titulo;
  for (const o of others) {
    if (realTitle(o.titulo) && realTitle(finalTitle) && o.titulo!.trim() !== finalTitle.trim()) {
      conflicts.push(`titulo diverge em ${o.id}; mantido o do canônico`);
    }
    if (filled(o.thumbnail) && filled(merge.thumbnail ?? canonical.thumbnail) && o.thumbnail !== (merge.thumbnail ?? canonical.thumbnail)) {
      conflicts.push(`thumbnail diverge em ${o.id}; mantida a do canônico`);
    }
  }

  // URLs: espelhos complementares são somados, na ordem do canônico primeiro.
  for (const field of ["urlDub", "urlLeg"] as const) {
    let value = canonical[field];
    for (const o of others) for (const url of splitUrls(o[field])) value = mergeProviderUrl(value, url);
    if ((value ?? null) !== (canonical[field] ?? null) && filled(value)) merge[field] = value;
  }

  // WatchHistory: um registro por (userId, conteudoId); fica o mais recente.
  const canonicalId = canonical.id;
  const byUser = new Map<string, DedupeWatch[]>();
  for (const w of watch) {
    const k = `${w.userId}\u0000${w.conteudoId}`;
    byUser.set(k, [...(byUser.get(k) ?? []), w]);
  }
  const watchMove: string[] = [];
  const watchDrop: string[] = [];
  const watchMarkDone: string[] = [];
  for (const rows of byUser.values()) {
    const best = [...rows].sort((a, b) =>
      b.updatedAt.getTime() - a.updatedAt.getTime() || b.progressoSeg - a.progressoSeg || (a.id < b.id ? -1 : 1))[0];
    for (const r of rows) if (r.id !== best.id) watchDrop.push(r.id);
    if (best.episodioId !== canonicalId) watchMove.push(best.id);
    if (rows.length > 1 && !best.concluido && rows.some((r) => r.concluido)) watchMarkDone.push(best.id);
  }

  return {
    coordinate,
    ids: group.map((g) => g.id).sort(),
    canonicalId,
    removeIds: others.map((o) => o.id),
    merge,
    watchMove,
    watchDrop,
    watchMarkDone,
    conflicts,
  };
}

// ── Execução ────────────────────────────────────────────────────────────────

/** Subconjunto do Prisma usado aqui (o fake dos testes implementa o mesmo). */
export type DedupeDb = {
  episodio: {
    findMany(args: any): Promise<DedupeEpisode[]>;
    update(args: any): Promise<unknown>;
    deleteMany(args: any): Promise<{ count: number }>;
  };
  watchHistory: {
    findMany(args: any): Promise<DedupeWatch[]>;
    update(args: any): Promise<unknown>;
    deleteMany(args: any): Promise<{ count: number }>;
    count(args: any): Promise<number>;
  };
  $transaction<T>(fn: (tx: any) => Promise<T>, options?: any): Promise<T>;
};

export type DedupeReport = {
  mode: "dry-run" | "apply";
  grupos: number;
  linhas: number;
  canonicos: number;
  removiveis: number;
  fksMover: number;
  watchMesclar: number;
  camposMesclar: number;
  conflitos: string[];
  erros: string[];
  aplicados: number;
  backupFile: string | null;
};

export type DedupeOptions = {
  mode: "dry-run" | "apply";
  /** Obrigatório em apply. O arquivo é escrito ANTES de qualquer alteração. */
  writeBackup?: (payload: unknown) => Promise<string>;
  listDuplicates: () => Promise<Coordinate[]>;
  log?: (line: string) => void;
};

const EP_SELECT = { id: true, serieId: true, temporada: true, numeroEp: true, titulo: true, thumbnail: true, urlDub: true, urlLeg: true, createdAt: true };
const WATCH_SELECT = { id: true, userId: true, conteudoId: true, episodioId: true, progressoSeg: true, concluido: true, updatedAt: true };

async function loadGroup(db: DedupeDb | any, c: Coordinate) {
  const eps: DedupeEpisode[] = await db.episodio.findMany({
    where: { serieId: c.serieId, temporada: c.temporada, numeroEp: c.numeroEp },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: EP_SELECT,
  });
  const watch: DedupeWatch[] = eps.length
    ? await db.watchHistory.findMany({ where: { episodioId: { in: eps.map((e) => e.id) } }, orderBy: { id: "asc" }, select: WATCH_SELECT })
    : [];
  return { eps, watch };
}

/** Aplica um grupo dentro de uma transação; qualquer invariante quebrada → rollback. */
async function applyGroup(tx: any, plan: GroupPlan) {
  const { eps } = await loadGroup(tx, plan.coordinate);
  const current = eps.map((e) => e.id).sort();
  if (current.join("\u0000") !== plan.ids.join("\u0000")) throw new Error("grupo mudou desde o planejamento");

  if (Object.keys(plan.merge).length > 0) await tx.episodio.update({ where: { id: plan.canonicalId }, data: plan.merge });
  // Apagar as colisões antes de mover: o único (userId, conteudoId, episodioId) não pode estourar.
  if (plan.watchDrop.length) await tx.watchHistory.deleteMany({ where: { id: { in: plan.watchDrop } } });
  for (const id of plan.watchMove) await tx.watchHistory.update({ where: { id }, data: { episodioId: plan.canonicalId } });
  for (const id of plan.watchMarkDone) await tx.watchHistory.update({ where: { id }, data: { concluido: true } });

  const orphan = await tx.watchHistory.count({ where: { episodioId: { in: plan.removeIds } } });
  if (orphan !== 0) throw new Error(`invariante: ${orphan} WatchHistory ainda aponta para duplicata`);
  const removed = await tx.episodio.deleteMany({ where: { id: { in: plan.removeIds } } });
  if (removed.count !== plan.removeIds.length) throw new Error("invariante: remoção parcial");

  const after = await tx.episodio.findMany({ where: plan.coordinate, select: EP_SELECT });
  if (after.length !== 1 || after[0].id !== plan.canonicalId) throw new Error("invariante: coordenada não ficou com uma linha só");
  for (const field of ["titulo", "thumbnail", "urlDub", "urlLeg"] as const) {
    const before = eps.find((e) => e.id === plan.canonicalId)![field];
    if (filled(before) && !filled(after[0][field])) throw new Error(`invariante: ${field} válido foi apagado`);
    const merged = plan.merge[field];
    if (merged !== undefined && after[0][field] !== merged) throw new Error(`invariante: ${field} mesclado não foi gravado`);
  }
}

export async function runEpisodeDedupe(db: DedupeDb, options: DedupeOptions): Promise<DedupeReport> {
  const log = options.log ?? (() => {});
  const report: DedupeReport = {
    mode: options.mode, grupos: 0, linhas: 0, canonicos: 0, removiveis: 0, fksMover: 0,
    watchMesclar: 0, camposMesclar: 0, conflitos: [], erros: [], aplicados: 0, backupFile: null,
  };
  if (options.mode === "apply" && !options.writeBackup) throw new Error("--apply exige backup (--backup-dir)");

  const coords = await options.listDuplicates();
  const plans: GroupPlan[] = [];
  const backup: Array<{ coordinate: Coordinate; episodios: DedupeEpisode[]; watchHistory: DedupeWatch[] }> = [];
  for (const c of coords) {
    try {
      const { eps, watch } = await loadGroup(db, c);
      if (eps.length < 2) continue;
      const plan = planGroup(eps, watch);
      plans.push(plan);
      backup.push({ coordinate: c, episodios: eps, watchHistory: watch });
      report.grupos++;
      report.linhas += eps.length;
      report.canonicos++;
      report.removiveis += plan.removeIds.length;
      report.fksMover += plan.watchMove.length;
      report.watchMesclar += plan.watchDrop.length;
      report.camposMesclar += Object.keys(plan.merge).length;
      for (const conflict of plan.conflicts) report.conflitos.push(`${c.serieId} T${c.temporada}E${c.numeroEp}: ${conflict}`);
    } catch (error) {
      report.erros.push(`${c.serieId} T${c.temporada}E${c.numeroEp}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.mode === "dry-run") return report;
  if (report.erros.length > 0) throw new Error(`planejamento com ${report.erros.length} erro(s); nada foi alterado`);
  if (plans.length === 0) return report;

  report.backupFile = await options.writeBackup!({ geradoEm: new Date().toISOString(), grupos: backup });
  log(`backup: ${report.backupFile}`);

  for (const plan of plans) {
    try {
      await db.$transaction((tx) => applyGroup(tx, plan), { timeout: 30_000 });
      report.aplicados++;
    } catch (error) {
      // Grupo desfeito pelo rollback; os seguintes nem começam.
      const c = plan.coordinate;
      report.erros.push(`${c.serieId} T${c.temporada}E${c.numeroEp}: ${error instanceof Error ? error.message : String(error)} — abortado`);
      break;
    }
  }
  return report;
}
