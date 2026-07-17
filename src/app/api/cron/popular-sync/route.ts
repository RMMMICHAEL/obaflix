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
    if (!row) continue; // stub ainda não foi criado (acontece na 1ª execução de um título novo)
    stillPresent.add(row.id);
    if (row.popularRank == null) {
      updates.push({ id: row.id, rank, prevRank: null });
      added.push(row.id);
    } else if (row.popularRank !== rank) {
      updates.push({ id: row.id, rank, prevRank: row.popularRank });
      repositioned.push(row.id);
    }
    // rank igual → sem escrita (sem popular_checked_at desnecessário)
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

async function applyDiff(tipo: "filme" | "serie", diff: RankDiff) {
  if (diff.updates.length > 0) {
    // Atualiza popularRank E salva o rank anterior (para "em alta" / tendências)
    const rows = diff.updates.map((u) =>
      Prisma.sql`(${u.id}::text, ${u.rank}::int4, ${u.prevRank ?? null}::int4)`
    );
    if (tipo === "filme") {
      await prisma.$executeRaw`
        UPDATE "Filme" AS t
        SET "popularRank"     = v.rank,
            "popularRankPrev" = v.prev_rank,
            "popularCheckedAt" = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, rank, prev_rank)
        WHERE t.id = v.id`;
    } else {
      await prisma.$executeRaw`
        UPDATE "Serie" AS t
        SET "popularRank"     = v.rank,
            "popularRankPrev" = v.prev_rank,
            "popularCheckedAt" = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, rank, prev_rank)
        WHERE t.id = v.id`;
    }
  }

  if (diff.clears.length > 0) {
    if (tipo === "filme") {
      await prisma.filme.updateMany({
        where: { id: { in: diff.clears } },
        data: { popularRank: null }, // popularRankPrev mantido — mostra onde estava antes
      });
    } else {
      await prisma.serie.updateMany({
        where: { id: { in: diff.clears } },
        data: { popularRank: null },
      });
    }
  }

  if (diff.updates.length > 0) {
    await prisma.popularHistory.createMany({
      data: diff.updates.map((u) => ({
        conteudoId: u.id,
        conteudoTipo: tipo,
        rank: u.rank,
      })),
    });
  }
}

// Cria registros "stub" para títulos populares que não existem no catálogo.
// Stubs têm urlDub=null (sem player) mas aparecem em rankings e buscas.
// Na próxima execução do cron, o diff já os encontra e atribui popularRank.
async function createStubs(
  tipo: "filme" | "serie",
  missing: PopularItem[],
  dryRun: boolean,
): Promise<{ created: number; skipped: number }> {
  const withMeta = missing.filter((i) => i.titulo);
  if (withMeta.length === 0) return { created: 0, skipped: missing.length };

  if (dryRun) return { created: 0, skipped: withMeta.length };

  // Verifica duplicata por tmdbId antes de criar
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
        // urlDub/urlLeg = null → stub sem player
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
        // urlDub via episódios = null → stub sem player
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
  let ok = true;

  try {
    const [movies, series] = await Promise.all([
      tmdbPopularSource.getPopularMovies(FETCH_LIMIT),
      tmdbPopularSource.getPopularSeries(FETCH_LIMIT),
    ]);
    bytesTransferred = movies.bytesTransferred + series.bytesTransferred;
    found = movies.items.length + series.items.length;

    // ── Guardas de sanidade ────────────────────────────────────────────────────
    if (movies.items.length < FETCH_LIMIT * MIN_RATIO_OK) {
      throw new Error(`Poucos filmes retornados pelo TMDB: ${movies.items.length}/${FETCH_LIMIT}`);
    }
    if (series.items.length < FETCH_LIMIT * MIN_RATIO_OK) {
      throw new Error(`Poucas séries retornadas pelo TMDB: ${series.items.length}/${FETCH_LIMIT}`);
    }

    const moviesDedup = dedupeByTmdbId(movies.items);
    const seriesDedup = dedupeByTmdbId(series.items);

    if (moviesDedup.duplicates / movies.items.length > MAX_DUP_RATIO) {
      throw new Error(`Duplicidade alta em filmes: ${moviesDedup.duplicates}/${movies.items.length}`);
    }
    if (seriesDedup.duplicates / series.items.length > MAX_DUP_RATIO) {
      throw new Error(`Duplicidade alta em séries: ${seriesDedup.duplicates}/${series.items.length}`);
    }

    // Valida: filmes e séries não misturados (sanidade de tipo)
    const movieIds = moviesDedup.items.map((i) => i.tmdbId);
    const serieIds = seriesDedup.items.map((i) => i.tmdbId);
    const overlap  = movieIds.filter((id) => serieIds.includes(id));
    if (overlap.length > 5) {
      throw new Error(`Alta sobreposição entre filmes e séries (${overlap.length} ids em comum) — resposta suspeita`);
    }

    const movieRankMap = new Map(moviesDedup.items.map((i) => [i.tmdbId, i.rank]));
    const serieRankMap = new Map(seriesDedup.items.map((i) => [i.tmdbId, i.rank]));

    // ── Busca registros atuais no banco ────────────────────────────────────────
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

    // ── Stubs: títulos populares não encontrados no catálogo ───────────────────
    const existingFilmeTmdb = new Set(currentFilmes.map((f) => f.tmdbId).filter(Boolean) as string[]);
    const existingSerieTmdb = new Set(currentSeries.map((s) => s.tmdbId).filter(Boolean) as string[]);

    const missingFilmes = moviesDedup.items.filter((i) => !existingFilmeTmdb.has(i.tmdbId));
    const missingSeries = seriesDedup.items.filter((i) => !existingSerieTmdb.has(i.tmdbId));

    const [filmeStubs, serieStubs] = await Promise.all([
      createStubs("filme", missingFilmes, dryRun),
      createStubs("serie", missingSeries, dryRun),
    ]);
    stubsCreated = filmeStubs.created + serieStubs.created;

    // Após criar stubs, inclui-os no diff desta execução (sem re-fetch ao banco)
    for (const s of missingFilmes.filter((i) => i.titulo)) {
      currentFilmes.push({ id: `tmdb_${s.tmdbId}`, tmdbId: s.tmdbId, popularRank: null });
    }
    for (const s of missingSeries.filter((i) => i.titulo)) {
      currentSeries.push({ id: `tmdb_${s.tmdbId}`, tmdbId: s.tmdbId, popularRank: null });
    }

    // ── Diff e aplicação ───────────────────────────────────────────────────────
    const filmeDiff = computeDiff(currentFilmes as RankRow[], movieRankMap);
    const serieDiff = computeDiff(currentSeries as RankRow[], serieRankMap);

    added       = filmeDiff.addedCount       + serieDiff.addedCount;
    removed     = filmeDiff.removedCount     + serieDiff.removedCount;
    repositioned = filmeDiff.repositionedCount + serieDiff.repositionedCount;

    if (!dryRun) {
      await Promise.all([applyDiff("filme", filmeDiff), applyDiff("serie", serieDiff)]);
      if (added + removed + repositioned > 0) revalidatePath("/melhores");
    }

    const durationMs = Date.now() - startedAt;
    if (!dryRun) {
      await prisma.syncMetric.create({
        data: {
          job: "popular-sync", source: "tmdb", durationMs,
          found, added, removed, repositioned, bytesTransferred,
          errors: 0, ok: true,
          detail: `stubs_criados=${stubsCreated}`,
        },
      }).catch(() => {});
      await redis.del(LOCK_KEY);
    }

    return NextResponse.json({
      ok: true, dryRun, found, added, removed, repositioned,
      stubsCreated, durationMs, bytesTransferred,
      diff: {
        filmes: { added: filmeDiff.added, removed: filmeDiff.removed, repositioned: filmeDiff.repositioned },
        series: { added: serieDiff.added, removed: serieDiff.removed, repositioned: serieDiff.repositioned },
      },
      stubs: {
        filmes: { created: filmeStubs.created, skipped: filmeStubs.skipped, missing: missingFilmes.length },
        series: { created: serieStubs.created, skipped: serieStubs.skipped, missing: missingSeries.length },
      },
    });
  } catch (err: any) {
    ok = false;
    errorMessage = err?.message ?? String(err);
    const durationMs = Date.now() - startedAt;

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
