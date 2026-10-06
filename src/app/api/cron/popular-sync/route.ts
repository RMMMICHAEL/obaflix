export const dynamic = "force-dynamic";
/**
 * 60s: teto seguro do Hobby sem Fluid Compute. A coleta e ~50 requisicoes ao
 * TMDB mais uma transacao, entao cabe com folga. Se estourar, o lock de 10min
 * expira muito antes da janela do dia seguinte.
 */
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { withCronTelemetry } from "@/lib/sync-telemetry";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanupCatalogStubs } from "@/lib/catalog-stub-cleanup";
import { getRedis } from "@/lib/redis";
import { tmdbPopularSource, validatePopularBatch, type PopularItem } from "@/lib/popular-source";

const LOCK_KEY    = "cron:popular-sync:lock";
const LOCK_TTL_S  = 600;
const FETCH_LIMIT = 500; // coleta Top 500 para detectar tendências antes do Top 250
// O adaptador já entrega únicos (ver collectPopular); esta passada é só uma
// segunda barreira barata antes de escrever no banco.
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
    if (!row) continue; // Top TMDB só ranqueia o catálogo existente.
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

async function handleGET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
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
  const stubsCreated = 0; // Compatibilidade: o sync não cria catálogo.
  let duplicatesIgnored = 0;
  let stubsDeleted = { filmes: 0, series: 0 };

  try {
    // ── 1. Fetch TMDB ─────────────────────────────────────────────────────────
    const [movies, series] = await Promise.all([
      tmdbPopularSource.getPopularMovies(FETCH_LIMIT),
      tmdbPopularSource.getPopularSeries(FETCH_LIMIT),
    ]);
    bytesTransferred = movies.bytesTransferred + series.bytesTransferred;
    found = movies.items.length + series.items.length;

    // ── 2. Guardas de sanidade (ver validatePopularBatch) ─────────────────────
    validatePopularBatch(FETCH_LIMIT, movies, series);
    const moviesDedup = dedupeByTmdbId(movies.items);
    const seriesDedup = dedupeByTmdbId(series.items);
    duplicatesIgnored = movies.stats.duplicates + series.stats.duplicates;

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

    // ── 4. Ausentes: somente telemetria, nunca criação de catálogo ────────────
    const existingFilmeTmdb = new Set(currentFilmes.map((f) => f.tmdbId).filter(Boolean) as string[]);
    const existingSerieTmdb = new Set(currentSeries.map((s) => s.tmdbId).filter(Boolean) as string[]);

    const missingFilmes = moviesDedup.items.filter((i) => !existingFilmeTmdb.has(i.tmdbId));
    const missingSeries = seriesDedup.items.filter((i) => !existingSerieTmdb.has(i.tmdbId));

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

      // ── 7. Remove stubs sem player, mesmo com rank; conteúdo real é protegido.
      stubsDeleted = await cleanupCatalogStubs(prisma);

      // /melhores é force-dynamic e lê o banco em cada requisição; não há cache
      // de página da Vercel para invalidar após uma execução local.
    }

    const durationMs = Date.now() - startedAt;

    if (!dryRun) {
      await prisma.syncMetric.create({
        data: {
          job: "popular-sync", source: "tmdb", durationMs,
          found, added, removed, repositioned, bytesTransferred,
          errors: 0, ok: true,
          detail: JSON.stringify({ stubsCreated, stubsDeleted, duplicatesIgnored }),
        },
      }).catch(() => {});
      await redis.del(LOCK_KEY);
    }

    return NextResponse.json({
      ok: true, dryRun, found, added, removed, repositioned,
      stubsCreated, stubsDeleted, duplicatesIgnored, durationMs, bytesTransferred,
      diff: {
        filmes: { added: filmeDiff.added, removed: filmeDiff.removed, repositioned: filmeDiff.repositioned },
        series: { added: serieDiff.added, removed: serieDiff.removed, repositioned: serieDiff.repositioned },
      },
      stubs: {
        filmes: { created: 0, missing: missingFilmes.length },
        series: { created: 0, missing: missingSeries.length },
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

// Registra SyncRun "tmdb-popular-vercel"; o runner local grava "tmdb-popular-local" por conta própria.
export const GET = withCronTelemetry("tmdb-popular", handleGET);
