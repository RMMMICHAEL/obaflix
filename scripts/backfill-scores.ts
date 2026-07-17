/**
 * backfill-scores.ts
 * Preenche voteCount/popularidade/scoreDestaque (ranking ponderado) para todo o
 * catálogo já importado, e corrige o campo `tipo` das séries (anime/desenho/serie)
 * usando o `origin_country` real do TMDB — corrige qualquer item mal categorizado
 * por qualquer um dos importadores (ex: cartoon ocidental marcado como "anime").
 *
 * Resumível: por padrão só processa itens ainda pendentes (voteCount OU
 * imdbId nulos) — se o processo for interrompido, rodar de novo continua de
 * onde parou, sem reprocessar o que já foi gravado. Grava em lotes (1 UPDATE
 * com múltiplas linhas via VALUES, não 1 round-trip por item), o que é a maior
 * fonte de ganho de velocidade comparado a `update()` individual por linha.
 *
 * Uso:
 *   npx tsx scripts/backfill-scores.ts                          # dry run, só pendentes
 *   npx tsx scripts/backfill-scores.ts --import                  # grava, só pendentes (retoma de onde parou)
 *   npx tsx scripts/backfill-scores.ts --import --force           # reprocessa tudo (refresh periódico completo)
 *   npx tsx scripts/backfill-scores.ts --import --concurrency 15 --batch-size 200
 */

import { PrismaClient, Prisma } from "@prisma/client";
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

// AbortSignal.timeout() sob concorrência alta às vezes lança de dentro do
// próprio timer (Timeout._onTimeout), fora da cadeia de promises do fetch —
// isso vira uncaughtException, não unhandledRejection, e derruba o processo
// mesmo com try/catch no fetch (bug conhecido do fetch nativo do Node/undici
// sob alta concorrência). Sem esses dois handlers, um timeout isolado mata
// horas de progresso; com eles, o item específico falha (vira erro, contabilizado
// no contador) e o resto do lote continua normalmente.
process.on("unhandledRejection", (reason) => {
  console.error(`\n⚠️  unhandledRejection ignorado (não derruba o processo): ${reason}`);
});
process.on("uncaughtException", (err) => {
  console.error(`\n⚠️  uncaughtException ignorada (não derruba o processo): ${err?.message ?? err}`);
});

const prisma = new PrismaClient();

const args        = process.argv.slice(2);
const getArg      = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag     = (f: string) => args.includes(f);

const DO_IMPORT   = hasFlag("--import");
const FORCE       = hasFlag("--force"); // reprocessa itens já sincronizados também
const CONCURRENCY = Number(getArg("--concurrency") ?? "10"); // paralelismo de fetch no TMDB
const BATCH_SIZE  = Number(getArg("--batch-size") ?? "200"); // linhas por UPDATE em lote
const TMDB_KEY    = process.env.TMDB_API_KEY;
const BASE        = "https://api.themoviedb.org/3";

// ── Ranking ponderado (Bayesian/IMDB weighted rating) ──────────────────────────
// WR = (v/(v+m))*R + (m/(v+m))*C  — depois soma um pequeno boost de popularidade
// (log-compressed, não domina a nota). Ajustável aqui.
const MIN_VOTES  = 300; // m: votos mínimos p/ confiança plena na nota
const AVG_NOTA   = 6.5; // C: média-base assumida do catálogo
const EPS        = 0.001; // tolerância p/ considerar dois floats "iguais" (evita write desnecessário)

function computeScoreDestaque(nota: number | null, voteCount: number | null, popularidade: number | null): number | null {
  if (nota == null) return null;
  const v = voteCount ?? 0;
  const wr = (v / (v + MIN_VOTES)) * nota + (MIN_VOTES / (v + MIN_VOTES)) * AVG_NOTA;
  const popBoost = Math.min(Math.log10((popularidade ?? 0) + 1), 4) * 0.15;
  return Math.round((wr + popBoost) * 1000) / 1000;
}

// Mesma heurística já usada corretamente em import.ts / import-embedmovies.mjs
function detectTipoSerie(generoIds: number[], originCountries: string[] | undefined): "anime" | "desenho" | "serie" {
  const isAnimacao = generoIds.includes(16);
  if (!isAnimacao) return "serie";
  return originCountries?.includes("JP") ? "anime" : "desenho";
}

function numDiff(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > EPS;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
    }),
  );
}

async function tmdbFetch(path: string): Promise<any | null> {
  // AbortController manual em vez de AbortSignal.timeout(): sob concorrência
  // alta, o timer interno do AbortSignal.timeout() já derrubou o processo
  // duas vezes com uma exceção fora da cadeia de promises do fetch (bug do
  // fetch nativo do Node/undici). abort() manual num setTimeout comum é o
  // caminho testado/estável.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BASE}${path}?api_key=${TMDB_KEY}&language=pt-BR`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function fmtETA(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "?";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

class Progress {
  private startedAt = Date.now();
  processed = 0;
  updated = 0;
  skipped = 0;
  erros = 0;
  constructor(private label: string, private total: number) {}

  tick(kind: "updated" | "skipped" | "erro") {
    this.processed++;
    if (kind === "updated") this.updated++;
    else if (kind === "skipped") this.skipped++;
    else this.erros++;
    if (this.processed % 200 === 0 || this.processed === this.total) this.log();
  }

  log() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.processed / Math.max(elapsed, 0.001);
    const eta = rate > 0 ? (this.total - this.processed) / rate : Infinity;
    const pct = ((this.processed / this.total) * 100).toFixed(1);
    console.log(
      `  [${this.label}] ${this.processed}/${this.total} (${pct}%) | atualizados:${this.updated} iguais:${this.skipped} erros:${this.erros} | ${rate.toFixed(1)}/s | ETA ${fmtETA(eta)}`,
    );
  }
}

// ── Batch flush (UPDATE em lote via VALUES) ─────────────────────────────────

interface FilmeUpdate { id: string; nota: number | null; voteCount: number | null; popularidade: number | null; scoreDestaque: number | null; imdbId: string | null }
interface SerieUpdate extends FilmeUpdate { tipo: "anime" | "desenho" | "serie" }

async function flushFilmes(batch: FilmeUpdate[]) {
  if (batch.length === 0 || !DO_IMPORT) return;
  const rows = batch.map((u) =>
    Prisma.sql`(${u.id}::text, ${u.nota}::float8, ${u.voteCount}::int4, ${u.popularidade}::float8, ${u.scoreDestaque}::float8, ${u.imdbId}::text)`
  );
  await prisma.$executeRaw`
    UPDATE "Filme" AS t
    SET nota = v.c1, "voteCount" = v.c2, popularidade = v.c3, "scoreDestaque" = v.c4, "imdbId" = COALESCE(v.c5, t."imdbId")
    FROM (VALUES ${Prisma.join(rows)}) AS v(id, c1, c2, c3, c4, c5)
    WHERE t.id = v.id
  `;
}

async function flushSeries(batch: SerieUpdate[]) {
  if (batch.length === 0 || !DO_IMPORT) return;
  const rows = batch.map((u) =>
    Prisma.sql`(${u.id}::text, ${u.nota}::float8, ${u.voteCount}::int4, ${u.popularidade}::float8, ${u.scoreDestaque}::float8, ${u.tipo}::text, ${u.imdbId}::text)`
  );
  await prisma.$executeRaw`
    UPDATE "Serie" AS t
    SET nota = v.c1, "voteCount" = v.c2, popularidade = v.c3, "scoreDestaque" = v.c4, tipo = v.c5, "imdbId" = COALESCE(v.c6, t."imdbId")
    FROM (VALUES ${Prisma.join(rows)}) AS v(id, c1, c2, c3, c4, c5, c6)
    WHERE t.id = v.id
  `;
}

// Buffer com flush automático quando atinge BATCH_SIZE — funciona como
// checkpoint: cada lote gravado fica persistido mesmo se o processo for
// interrompido depois, e o modo resumível (voteCount IS NULL) pega o resto.
function makeBuffer<T>(flush: (batch: T[]) => Promise<void>) {
  let buf: T[] = [];
  let flushing: Promise<void> = Promise.resolve();
  return {
    async push(item: T) {
      buf.push(item);
      if (buf.length >= BATCH_SIZE) {
        const batch = buf;
        buf = [];
        flushing = flushing.then(() => flush(batch));
        await flushing;
      }
    },
    async drain() {
      const batch = buf;
      buf = [];
      flushing = flushing.then(() => flush(batch));
      await flushing;
    },
  };
}

// ── Filmes ────────────────────────────────────────────────────────────────────

async function backfillFilmes() {
  console.log("\n🎬 FILMES");
  const where: any = { tmdbId: { not: null } };
  if (!FORCE) where.OR = [{ voteCount: null }, { imdbId: null }];

  const filmes = await prisma.filme.findMany({
    where,
    select: { id: true, tmdbId: true, nota: true, voteCount: true, popularidade: true, scoreDestaque: true, imdbId: true },
  });
  console.log(`  ${filmes.length} filmes a processar${FORCE ? " (--force: todos)" : " (pendentes)"}`);
  if (filmes.length === 0) { console.log("  ✅ Nada a fazer."); return; }

  const progress = new Progress("filmes", filmes.length);
  const buffer = makeBuffer(flushFilmes);

  await pool(filmes, CONCURRENCY, async (f) => {
    const details = await tmdbFetch(`/movie/${f.tmdbId}`);
    if (!details?.id) { progress.tick("erro"); return; }

    const nota = typeof details.vote_average === "number" ? details.vote_average : null;
    const voteCount = typeof details.vote_count === "number" ? details.vote_count : null;
    const popularidade = typeof details.popularity === "number" ? details.popularity : null;
    const scoreDestaque = computeScoreDestaque(nota, voteCount, popularidade);
    // imdb_id já vem de graça no /movie/{id}, sem chamada extra
    const imdbId: string | null = typeof details.imdb_id === "string" && details.imdb_id ? details.imdb_id : null;

    const changed = numDiff(nota, f.nota) || voteCount !== f.voteCount || numDiff(popularidade, f.popularidade) || numDiff(scoreDestaque, f.scoreDestaque) || (imdbId != null && imdbId !== f.imdbId);
    if (!changed) { progress.tick("skipped"); return; }

    await buffer.push({ id: f.id, nota, voteCount, popularidade, scoreDestaque, imdbId });
    progress.tick("updated");
  });

  await buffer.drain();
  progress.log();
  console.log(`  ✅ Filmes concluídos${DO_IMPORT ? "" : " (dry-run, nada gravado)"}`);
}

// ── Séries / Animes / Desenhos ───────────────────────────────────────────────

async function backfillSeries() {
  console.log("\n📺 SÉRIES / ANIMES / DESENHOS");
  const where: any = { tmdbId: { not: null } };
  if (!FORCE) where.OR = [{ voteCount: null }, { imdbId: null }];

  const series = await prisma.serie.findMany({
    where,
    select: { id: true, tmdbId: true, tipo: true, nota: true, voteCount: true, popularidade: true, scoreDestaque: true, imdbId: true },
  });
  console.log(`  ${series.length} séries a processar${FORCE ? " (--force: todas)" : " (pendentes)"}`);
  if (series.length === 0) { console.log("  ✅ Nada a fazer."); return; }

  const progress = new Progress("séries", series.length);
  const buffer = makeBuffer(flushSeries);
  let reclassificadas = 0;

  await pool(series, CONCURRENCY, async (s) => {
    const details = await tmdbFetch(`/tv/${s.tmdbId}`);
    if (!details?.id) { progress.tick("erro"); return; }

    const nota = typeof details.vote_average === "number" ? details.vote_average : null;
    const voteCount = typeof details.vote_count === "number" ? details.vote_count : null;
    const popularidade = typeof details.popularity === "number" ? details.popularity : null;
    const scoreDestaque = computeScoreDestaque(nota, voteCount, popularidade);

    // /tv/{id} não retorna imdb_id — só busca external_ids se ainda não tivermos
    let imdbId: string | null = s.imdbId ?? null;
    if (!imdbId) {
      const ext = await tmdbFetch(`/tv/${s.tmdbId}/external_ids`);
      if (typeof ext?.imdb_id === "string" && ext.imdb_id) imdbId = ext.imdb_id;
    }

    const generoIds: number[] = (details.genres ?? []).map((g: any) => g.id);
    const origins: string[] = details.origin_country ?? [];
    const tipo = detectTipoSerie(generoIds, origins);
    if (tipo !== s.tipo) reclassificadas++;

    const changed = numDiff(nota, s.nota) || voteCount !== s.voteCount || numDiff(popularidade, s.popularidade) || numDiff(scoreDestaque, s.scoreDestaque) || tipo !== s.tipo || imdbId !== s.imdbId;
    if (!changed) { progress.tick("skipped"); return; }

    await buffer.push({ id: s.id, nota, voteCount, popularidade, scoreDestaque, tipo, imdbId });
    progress.tick("updated");
  });

  await buffer.drain();
  progress.log();
  console.log(`  ✅ Séries concluídas | reclassificadas (tipo corrigido): ${reclassificadas}${DO_IMPORT ? "" : " (dry-run, nada gravado)"}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!TMDB_KEY) {
    console.error("❌ TMDB_API_KEY não configurado no ambiente.");
    process.exit(1);
  }

  console.log("══════════════════════════════════════════");
  console.log("   Backfill de scores/tipo — SureEdge");
  console.log(`   Modo: ${DO_IMPORT ? "IMPORT" : "DRY RUN"} | ${FORCE ? "FORCE (reprocessa tudo)" : "resumível (só pendentes)"} | Concurrency: ${CONCURRENCY} | Batch: ${BATCH_SIZE}`);
  console.log("══════════════════════════════════════════");

  if (!DO_IMPORT) console.log("\nSem --import, nada é salvo. Use --import para gravar.\n");

  const start = Date.now();
  await backfillFilmes();
  await backfillSeries();
  const mins = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`\n✅ Concluído em ${mins} minutos`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
