export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { tmdbPopularSource, type PopularItem } from "@/lib/popular-source";

const LOCK_KEY    = "cron:popular-sync:lock";
const LOCK_TTL_S  = 600;
const FETCH_LIMIT = 500; // coleta Top 500 para detectar tendências antes do Top 250
const MIN_RATIO_OK   = 0.8;
const MAX_DUP_RATIO  = 0.05;

// A lista do TMDB é viva — itens podem aparecer em duas páginas por drift de paginação.
// Mantém a primeira ocorrência (rank melhor) e só considera corrupção se a taxa for alta.
function dedupeByTmdbId(items: PopularItem[]): { items: PopularItem[]; duplicates: number } {
  const seen = new Set<string>();
  const out: PopularItem[] = [];
  let duplicates = 0;
  for (const it of items) {
    if (seen.has(it.tmdbId)) { duplicates++; continue; }
    seen.add(it.tmdbId);
    out.push(it);
  }
  return { items: out, duplicates };
}

interface RankRow { id: string; tmdbId: string; popularRank: number | null }
interface RankDiff {
  updates: { id: string; rank: number; prevRank: number | null }[];
  clears:  string[];
  added: string[]; addedCount: number;
  removed: string[]; removedCount: number;
  repositioned: string[]; repositionedCount: number;
}

function computeDiff(current: RankRow[], incoming: Map<string, number>): RankDiff {
  const currentByTmdb = new Map(current.filter((c) => c.tmdbId).map((c) => [c.tmdbId, c]));
  const updates: RankDiff["updates"] = [];
  const added: string[] = [];
  const repositioned: string[] = [];
  const stillPresent = new Set<string>();

  for (const [tmdbId, rank] of incoming) {
    const row = currentByTmdb.get(tmdbId);
    if (!row) continue; // título ausente do catálogo — stub ainda não foi criado
    stillPresent.add(row.id);
    if (row.popularRank == null) {
      // Entrando no ranking: prevRank = null (nunca esteve rankeado)
      updates.push({ id: row.id, rank, prevRank: null });
      added.push(row.id);
    } else if (row.popularRank !== rank) {
      // Reposicionado: prevRank = valor lido do banco NESTA execução = rank da execução anterior
      updates.push({ id: row.id, rank, prevRank: row.popularRank });
      repositioned.push(row.id);
    }
    // Rank igual → nenhuma escrita (sem popularCheckedAt desnecessário)
  }

  const clears = current
    .filter((c) => c.popularRank != null && !stillPresent.has(c.id))
    .map((c) => c.id);

  return {
    updates, clears,
    added, addedCount: added.length,
    removed: clears, removedCount: clears.length,
    repositioned, repositionedCount: repositioned.length,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyDiff(tipo: "filme" | "serie", diff: RankDiff, db: any = prisma) {
  if (diff.updates.length > 0) {
    const rows = diff.updates.map((u) =>
      Prisma.sql`(${u.id}::text, ${u.rank}::int4, ${u.prevRank ?? null}::int4)`
    );
    if (tipo === "filme") {
      await db.$executeRaw`
        UPDATE "Filme" AS t
        SET "popularRank"      = v.rank,
            "popularRankPrev"  = v.prev_rank,
            "popularCheckedAt" = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, rank, prev_rank)
        WHERE t.id = v.id`;
    } else {
      await db.$executeRaw`
        UPDATE "Serie" AS t
        SET "popularRank"      = v.rank,
            "popularRankPrev"  = v.prev_rank,
            "popularCheckedAt" = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, rank, prev_rank)
        WHERE t.id = v.id`;
    }
    // Histórico registra cada mudança real de posição (nunca grava se não houve alteração)
    await db.popularHistory.createMany({
      data: diff.updates.map((u) => ({
        conteudoId: u.id,
        conteudoTipo: tipo,
        rank: u.rank,
      })),
    });
  }

  if (diff.clears.length > 0) {
    // popularRankPrev mantido ao limpar — preserva memória de onde o título estava
    if (tipo === "filme") {
      await db.filme.updateMany({ where: { id: { in: diff.clears } }, data: { popularRank: null } });
    } else {
      await db.serie.updateMany({ where: { id: { in: diff.clears } }, data: { popularRank: null } });
    }
  }
}

// Remove stubs (id=tmdb_*) que saíram do ranking E não têm player.
// Evita acúmulo indefinido de registros sem valor. Executado fora da tx principal.
async function cleanupStubs(): Promise<{ filmes: number; series: number }> {
  try {
    const [f, s] = await Promise.all([
      prisma.filme.deleteMany({
        where: {
          id: { startsWith: "tmdb_" },
          popularRank: null,
          urlDub: null,
          urlLeg: null,
        },
      }),
      prisma.serie.deleteMany({
        where: {
          id: { startsWith: "tmdb_" },
          popularRank: null,
          episodios: { none: {} },
        },
      }),
    ]);
    return { filmes: f.count, series: s.count };
  } catch {
    return { filmes: 0, series: 0 };
  }
}

// Cria registros "stub" para títulos populares ausentes do catálogo.
// Stubs têm urlDub=null (sem player) mas participam de rankings e buscas.
async function createStubs(
  tipo: "filme" | "serie",
  missing: PopularItem[],
  dryRun: boolean,
): Promise<{ created: number; skipped: number }> {
  const withMeta = missing.filter((i) => i.titulo);
  if (withMeta.length === 0) return { created: 0, skipped: missing.length };
  if (dryRun) return { created: 0, skipped: withMeta.length };

  // Dupla verificação por tmdbId para não criar duplicata se título migrou de id
  const tmdbIds = withMeta.map((i) => i.tmdbId);
  const existsByTmdb =
    tipo === "filme"
      ? new Set((await prisma.filme.findMany({ where: { tmdbId: { in: tmdbIds } }, select: { tmdbId: true } })).map((r) => r.tmdbId!))
      : new Set((await prisma.serie.findMany({ where: { tmdbId: { in: tmdbIds } }, select: { tmdbId: true } })).map((r) => r.tmdbId!));

  const toCreate = withMeta.filter((i) => !existsByTmdb.has(i.tmdbId));
  if (toCreate.length === 0) return { created: 0, skipped: withMeta.length };

  if (tipo === "filme") {
    await prisma.filme.createMany({
      skipDuplicates: true,
      data: toCreate.map((i) => ({
        id: `tmdb_${i.tmdbId}`,
        tmdbId: i.tmdbId,
        titulo: i.titulo!,
        tituloOriginal: i.tituloOriginal ?? null,
        poster: i.poster ?? null,
        background: i.backdrop ?? null,
        ano: i.ano ?? null,
        nota: i.nota ?? null,
        voteCount: i.voteCount ?? null,
        popularidade: i.popularidade ?? null,
      })),
    });
  } else {
    await prisma.serie.createMany({
      skipDuplicates: true,
      data: toCreate.map((i) => ({
        id: `tmdb_${i.tmdbId}`,
        tmdbId: i.tmdbId,
        titulo: i.titulo!,
        tituloOriginal: i.tituloOriginal ?? null,
        poster: i.poster ?? null,
        background: i.backdrop ?? null,
        ano: i.ano ?? null,
        nota: i.nota ?? null,
        voteCount: i.voteCount ?? null,
        popularidade: i.popularidade ?? null,
        tipo: "serie",
      })),
    });
  }

  return { created: toCreate.length, skipped: withMeta.length - toCreate.length };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const redis = getRedis();
  const startedAt = Date.now();

  if (!dryRun) {
    const acquired = await redis.set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL_S });
    if (acquired !== "OK") {
      return NextResponse.json({ ok: true, skipped: true, reason: "já existe uma sincronização em andamento" });
    }
  }

  let errorMessage: string | null = null;
  let found = 0, added = 0, removed = 0, repositioned = 0, bytesTransferred = 0;
  let stubsCreated = 0;
  let stubsDeleted = { filmes: 0, series: 0 };

  try {
    // ── 1. Fetch TMDB ─────────────────────────────────────────────────────────
    const [movies, series] = await Promise.all([
      tmdbPopularSource.getPopularMovies(FETCH_LIMIT),
      tmdbPopularSource.getPopularSeries(FETCH_LIMIT),
    ]);
    bytesTransferred = movies.bytesTransferred + series.bytesTransferred;
    found = movies.items.length + series.items.length;

    // ── 2. Guardas de sanidade ────────────────────────────────────────────────
    if (movies.items.length < FETCH_LIMIT * MIN_RATIO_OK) {
      throw new Error(`Poucos filmes retornados: ${movies.items.length}/${FETCH_LIMIT}`);
    }
    if (series.items.length < FETCH_LIMIT * MIN_RATIO_OK) {
      throw new Error(`Poucas séries retornadas: ${series.items.length}/${FETCH_LIMIT}`);
    }

    const moviesDedup = dedupeByTmdbId(movies.items);
    const seriesDedup = dedupeByTmdbId(series.items);

    if (moviesDedup.duplicates / movies.items.length > MAX_DUP_RATIO) {
      throw new Error(`Duplicidade alta em filmes: ${moviesDedup.duplicates}/${movies.items.length}`);
    }
    if (seriesDedup.duplicates / series.items.length > MAX_DUP_RATIO) {
      throw new Error(`Duplicidade alta em séries: ${seriesDedup.duplicates}/${series.items.length}`);
    }

    // Filmes e séries não devem se misturar (sanidade de tipo da API)
    const movieTmdbSet = new Set(moviesDedup.items.map((i) => i.tmdbId));
    const overlapCount = seriesDedup.items.filter((i) => movieTmdbSet.has(i.tmdbId)).length;
    if (overlapCount > 5) {
      throw new Error(`Sobreposição suspeita entre filmes e séries: ${overlapCount} IDs em comum`);
    }

    const movieRankMap = new Map(moviesDedup.items.map((i) => [i.tmdbId, i.rank]));
    const serieRankMap = new Map(seriesDedup.items.map((i) => [i.tmdbId, i.rank]));
    const movieIds = moviesDedup.items.map((i) => i.tmdbId);
    const serieIds = seriesDedup.items.map((i) => i.tmdbId);

    // ── 3. Snapshot do banco (lido uma vez, antes de qualquer escrita) ─────────
    const [currentFilmes, currentSeries] = await Promise.all([
      prisma.filme.findMany({
        where: { OR: [{ tmdbId: { in: movieIds } }, { popularRank: { not: null } }] },
        select: { id: true, tmdbId: true, popularRank: true },
      }),
      prisma.serie.findMany({
        where: { OR: [{ tmdbId: { in: serieIds } }, { popularRank: { not: null } }] },
        select: { id: true, tmdbId: true, popularRank: true },
      }),
    ]);

    // ── 4. Stubs: criar títulos populares ausentes do catálogo ─────────────────
    const existingFilmeTmdb = new Set(currentFilmes.map((f) => f.tmdbId).filter(Boolean) as string[]);
    const existingSerieTmdb = new Set(currentSeries.map((s) => s.tmdbId).filter(Boolean) as string[]);

    const missingFilmes = moviesDedup.items.filter((i) => !existingFilmeTmdb.has(i.tmdbId));
    const missingSeries = seriesDedup.items.filter((i) => !existingSerieTmdb.has(i.tmdbId));

    const [filmeStubs, serieStubs] = await Promise.all([
      createStubs("filme", missingFilmes, dryRun),
      createStubs("serie", missingSeries, dryRun),
    ]);
    stubsCreated = filmeStubs.created + serieStubs.created;

    // Inclui stubs recém-criados no diff desta execução (sem re-fetch ao banco)
    if (!dryRun) {
      for (const s of missingFilmes.filter((i) => i.titulo)) {
        currentFilmes.push({ id: `tmdb_${s.tmdbId}`, tmdbId: s.tmdbId, popularRank: null });
      }
      for (const s of missingSeries.filter((i) => i.titulo)) {
        currentSeries.push({ id: `tmdb_${s.tmdbId}`, tmdbId: s.tmdbId, popularRank: null });
      }
    }

    // ── 5. Diff ───────────────────────────────────────────────────────────────
    const filmeDiff = computeDiff(currentFilmes as RankRow[], movieRankMap);
    const serieDiff = computeDiff(currentSeries as RankRow[], serieRankMap);

    added        = filmeDiff.addedCount        + serieDiff.addedCount;
    removed      = filmeDiff.removedCount      + serieDiff.removedCount;
    repositioned = filmeDiff.repositionedCount + serieDiff.repositionedCount;

    if (!dryRun) {
      // ── 6. Aplica diff em transação (updates + histórico atômicos) ────────────
      await prisma.$transaction(async (tx) => {
        await applyDiff("filme", filmeDiff, tx);
        await applyDiff("serie", serieDiff, tx);
      });

      // ── 7. Cleanup de stubs fora do ranking (fora da tx — operação independente)
      stubsDeleted = await cleanupStubs();

      // ── 8. Invalida cache apenas se houve mudança real ────────────────────────
      if (added + removed + repositioned > 0) revalidatePath("/melhores");
    }

    const durationMs = Date.now() - startedAt;

    if (!dryRun) {
      await prisma.syncMetric.create({
        data: {
          job: "popular-sync", source: "tmdb", durationMs,
          found, added, removed, repositioned, bytesTransferred,
          errors: 0, ok: true,
          detail: JSON.stringify({ stubsCreated, stubsDeleted }),
        },
      }).catch(() => {});
      await redis.del(LOCK_KEY);
    }

    return NextResponse.json({
      ok: true, dryRun, found, added, removed, repositioned,
      stubsCreated, stubsDeleted, durationMs, bytesTransferred,
      diff: {
        filmes: { added: filmeDiff.added, removed: filmeDiff.removed, repositioned: filmeDiff.repositioned },
        series: { added: serieDiff.added, removed: serieDiff.removed, repositioned: serieDiff.repositioned },
      },
      stubs: {
        filmes: { created: filmeStubs.created, missing: missingFilmes.length },
        series: { created: serieStubs.created, missing: missingSeries.length },
      },
    });
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    errorMessage = err?.message ?? String(err);

    if (!dryRun) {
      await prisma.syncMetric.create({
        data: {
          job: "popular-sync", source: "tmdb", durationMs,
          found, added: 0, removed: 0, repositioned: 0,
          bytesTransferred, errors: 1, ok: false, errorMessage,
        },
      }).catch(() => {});
      await redis.del(LOCK_KEY);
    }

    return NextResponse.json({ ok: false, dryRun, error: errorMessage }, { status: 500 });
  }
}
