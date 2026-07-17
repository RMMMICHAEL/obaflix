export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { tmdbPopularSource, type PopularItem } from "@/lib/popular-source";

const LOCK_KEY = "cron:popular-sync:lock";
const LOCK_TTL_S = 600; // trava expira sozinha se o processo morrer no meio
const LIMIT = 250; // mesmo tamanho do Top 250 já existente no sistema
const MIN_RATIO_OK = 0.8; // abaixo disso, considera resposta anormal e não grava
const MAX_DUP_RATIO = 0.05; // acima disso, considera resposta corrompida (não é só drift de paginação)

// A lista de popularidade do TMDB é viva — a posição de um item pode mudar
// entre a busca de uma página e a próxima (são ~13 chamadas sequenciais), o
// que ocasionalmente faz um item aparecer em duas páginas. Isso é ruído
// normal, não corrupção: mantém a primeira ocorrência (rank mais baixo/melhor)
// e só considera anormal se a taxa de duplicados for grande demais pra ser
// só drift de paginação.
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
  updates: { id: string; rank: number }[]; // adicionados + reposicionados
  clears: string[]; // removidos (popularRank -> null)
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
    if (!row) continue; // não está no catálogo — não rankeia (regra do sistema inteiro)
    stillPresent.add(row.id);
    if (row.popularRank == null) { updates.push({ id: row.id, rank }); added.push(row.id); }
    else if (row.popularRank !== rank) { updates.push({ id: row.id, rank }); repositioned.push(row.id); }
    // igual -> não escreve nada
  }

  const clears = current.filter((c) => c.popularRank != null && !stillPresent.has(c.id)).map((c) => c.id);

  return {
    updates, clears,
    added, addedCount: added.length,
    removed: clears, removedCount: clears.length,
    repositioned, repositionedCount: repositioned.length,
  };
}

async function applyDiff(tipo: "filme" | "serie", diff: RankDiff) {
  if (diff.updates.length > 0) {
    const rows = diff.updates.map((u) => Prisma.sql`(${u.id}::text, ${u.rank}::int4)`);
    if (tipo === "filme") {
      await prisma.$executeRaw`
        UPDATE "Filme" AS t SET "popularRank" = v.rank, "popularCheckedAt" = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, rank) WHERE t.id = v.id`;
    } else {
      await prisma.$executeRaw`
        UPDATE "Serie" AS t SET "popularRank" = v.rank, "popularCheckedAt" = now()
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, rank) WHERE t.id = v.id`;
    }
  }
  if (diff.clears.length > 0) {
    if (tipo === "filme") await prisma.filme.updateMany({ where: { id: { in: diff.clears } }, data: { popularRank: null } });
    else await prisma.serie.updateMany({ where: { id: { in: diff.clears } }, data: { popularRank: null } });
  }

  const historyRows = [
    ...diff.updates.map((u) => ({ conteudoId: u.id, conteudoTipo: tipo, rank: u.rank })),
  ];
  if (historyRows.length > 0) {
    await prisma.popularHistory.createMany({ data: historyRows });
  }
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

  // Concorrência: só uma execução por vez (dry-run não precisa da trava —
  // não escreve nada, pode rodar em paralelo com qualquer coisa)
  if (!dryRun) {
    const acquired = await redis.set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL_S });
    if (acquired !== "OK") {
      return NextResponse.json({ ok: true, skipped: true, reason: "já existe uma sincronização em andamento" });
    }
  }

  let errorMessage: string | null = null;
  let found = 0, added = 0, removed = 0, repositioned = 0, bytesTransferred = 0;
  let ok = true;

  try {
    const [movies, series] = await Promise.all([
      tmdbPopularSource.getPopularMovies(LIMIT),
      tmdbPopularSource.getPopularSeries(LIMIT),
    ]);
    bytesTransferred = movies.bytesTransferred + series.bytesTransferred;
    found = movies.items.length + series.items.length;

    // ── Guardas de sanidade — qualquer uma aborta sem gravar ──────────────────
    if (movies.items.length < LIMIT * MIN_RATIO_OK) {
      throw new Error(`Poucos filmes retornados pelo TMDB: ${movies.items.length}/${LIMIT}`);
    }
    if (series.items.length < LIMIT * MIN_RATIO_OK) {
      throw new Error(`Poucas séries retornadas pelo TMDB: ${series.items.length}/${LIMIT}`);
    }
    const moviesDedup = dedupeByTmdbId(movies.items);
    const seriesDedup = dedupeByTmdbId(series.items);
    if (moviesDedup.duplicates / movies.items.length > MAX_DUP_RATIO) {
      throw new Error(`Duplicidade alta na lista de filmes populares: ${moviesDedup.duplicates}/${movies.items.length} — resposta suspeita`);
    }
    if (seriesDedup.duplicates / series.items.length > MAX_DUP_RATIO) {
      throw new Error(`Duplicidade alta na lista de séries populares: ${seriesDedup.duplicates}/${series.items.length} — resposta suspeita`);
    }

    const movieIds = moviesDedup.items.map((i) => i.tmdbId);
    const serieIds = seriesDedup.items.map((i) => i.tmdbId);
    const movieRankMap = new Map(moviesDedup.items.map((i) => [i.tmdbId, i.rank]));
    const serieRankMap = new Map(seriesDedup.items.map((i) => [i.tmdbId, i.rank]));

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

    const filmeDiff = computeDiff(currentFilmes as RankRow[], movieRankMap);
    const serieDiff = computeDiff(currentSeries as RankRow[], serieRankMap);

    added = filmeDiff.addedCount + serieDiff.addedCount;
    removed = filmeDiff.removedCount + serieDiff.removedCount;
    repositioned = filmeDiff.repositionedCount + serieDiff.repositionedCount;

    if (!dryRun) {
      await Promise.all([applyDiff("filme", filmeDiff), applyDiff("serie", serieDiff)]);
      if (added + removed + repositioned > 0) revalidatePath("/melhores");
    }

    const durationMs = Date.now() - startedAt;
    if (!dryRun) {
      await prisma.syncMetric.create({
        data: {
          job: "popular-sync", source: "tmdb", durationMs, found, added, removed, repositioned,
          bytesTransferred, errors: 0, ok: true,
        },
      }).catch(() => {}); // métrica não deve derrubar a sincronização se falhar

      await redis.del(LOCK_KEY);
    }

    return NextResponse.json({
      ok: true, dryRun, found, added, removed, repositioned, durationMs, bytesTransferred,
      diff: {
        filmes: { added: filmeDiff.added, removed: filmeDiff.removed, repositioned: filmeDiff.repositioned },
        series: { added: serieDiff.added, removed: serieDiff.removed, repositioned: serieDiff.repositioned },
      },
    });
  } catch (err: any) {
    ok = false;
    errorMessage = err?.message ?? String(err);
    const durationMs = Date.now() - startedAt;

    if (!dryRun) {
      await prisma.syncMetric.create({
        data: {
          job: "popular-sync", source: "tmdb", durationMs, found, added: 0, removed: 0, repositioned: 0,
          bytesTransferred, errors: 1, ok: false, errorMessage,
        },
      }).catch(() => {});
      await redis.del(LOCK_KEY);
    }

    return NextResponse.json({ ok: false, dryRun, error: errorMessage }, { status: 500 });
  }
}
