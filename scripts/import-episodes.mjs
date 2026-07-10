/**
 * import-episodes.mjs
 * Importa temporadas e episódios do TMDB para séries que ainda não têm episódios.
 *
 * Usage:
 *   node scripts/import-episodes.mjs                    # séries sem nenhum episódio
 *   node scripts/import-episodes.mjs --all              # todas as séries (re-importa)
 *   node scripts/import-episodes.mjs --id 1396          # só uma série (tmdbId)
 *   node scripts/import-episodes.mjs --limit 100        # máximo N séries a processar
 *   node scripts/import-episodes.mjs --dry-run          # não grava no banco
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── Carrega .env ───────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1 || line.startsWith("#")) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
}

const TMDB_KEY = process.env.TMDB_API_KEY;
if (!TMDB_KEY) { console.error("TMDB_API_KEY não encontrada no .env"); process.exit(1); }

// ── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag  = (f) => args.includes(f);
const argVal = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

const IMPORT_ALL = flag("--all");
const DRY_RUN    = flag("--dry-run");
const SINGLE_ID  = argVal("--id");
const LIMIT      = Number(argVal("--limit") ?? 0);

// Delay entre chamadas TMDB — fica abaixo do limite de 50 req/10s
const TMDB_DELAY_MS = 130;

const prisma = new PrismaClient({ log: [] });
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));

// ── TMDB helpers ───────────────────────────────────────────────────────────
async function tmdbGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.themoviedb.org/3${path}${sep}api_key=${TMDB_KEY}&language=pt-BR`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

/** Busca episódios de uma temporada. Retorna array de objetos Episodio prontos. */
async function fetchSeason(serieId, tmdbId, season) {
  const data = await tmdbGet(`/tv/${tmdbId}/season/${season}`);
  if (!data?.episodes?.length) return [];

  return data.episodes.map((ep) => ({
    id:        `${serieId}-t${season}e${ep.episode_number}`,
    serieId,
    temporada: season,
    numeroEp:  ep.episode_number,
    titulo:    ep.name     || null,
    thumbnail: ep.still_path
               ? `https://image.tmdb.org/t/p/w300${ep.still_path}`
               : null,
  }));
}

// ── Importa episódios de uma série ────────────────────────────────────────
async function importSerie(serie, idx, total) {
  const prefix = `[${idx}/${total}] ${serie.titulo} (tmdbId: ${serie.tmdbId})`;

  if (!serie.tmdbId) {
    process.stdout.write(`\r  ${prefix} — sem tmdbId, pulando\n`);
    return { ok: 0, skipped: 1, failed: 0 };
  }

  // Busca detalhes para saber o número de temporadas
  const details = await tmdbGet(`/tv/${serie.tmdbId}`);
  await sleep(TMDB_DELAY_MS);

  if (!details?.number_of_seasons) {
    process.stdout.write(`\r  ${prefix} — TMDB não encontrou\n`);
    return { ok: 0, skipped: 1, failed: 0 };
  }

  const numSeasons = details.number_of_seasons;
  const allEpisodes = [];

  for (let s = 1; s <= numSeasons; s++) {
    process.stdout.write(`\r  ${prefix} — T${s}/${numSeasons}...          `);
    const eps = await fetchSeason(serie.id, serie.tmdbId, s);
    allEpisodes.push(...eps);
    await sleep(TMDB_DELAY_MS);
  }

  if (allEpisodes.length === 0) {
    return { ok: 0, skipped: 1, failed: 0 };
  }

  if (DRY_RUN) {
    process.stdout.write(`\r  [DRY-RUN] ${prefix} — ${allEpisodes.length} eps em ${numSeasons} temporadas\n`);
    return { ok: allEpisodes.length, skipped: 0, failed: 0 };
  }

  // createMany com skipDuplicates — seguro para re-execuções
  try {
    const result = await prisma.episodio.createMany({
      data: allEpisodes,
      skipDuplicates: true,
    });
    process.stdout.write(`\r  ${prefix} — ${result.count} eps novos (${allEpisodes.length} total, ${numSeasons} temp)\n`);
    return { ok: result.count, skipped: 0, failed: 0 };
  } catch (e) {
    process.stdout.write(`\r  ${prefix} — ERRO: ${e.message.slice(0, 60)}\n`);
    return { ok: 0, skipped: 0, failed: 1 };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== import-episodes ===`);
  console.log(`ALL: ${IMPORT_ALL}  DRY-RUN: ${DRY_RUN}  ID: ${SINGLE_ID ?? "—"}  LIMIT: ${LIMIT || "sem limite"}\n`);

  let series;

  if (SINGLE_ID) {
    // Modo específico: uma série pelo tmdbId
    series = await prisma.serie.findMany({ where: { tmdbId: SINGLE_ID } });
    if (!series.length) {
      console.error(`Série com tmdbId=${SINGLE_ID} não encontrada no banco.`);
      process.exit(1);
    }
  } else if (IMPORT_ALL) {
    // Todas as séries com tmdbId
    series = await prisma.serie.findMany({ where: { tmdbId: { not: null } } });
  } else {
    // Padrão: séries com tmdbId mas sem nenhum episódio
    series = await prisma.serie.findMany({
      where: {
        tmdbId: { not: null },
        episodios: { none: {} },
      },
    });
  }

  if (LIMIT > 0) series = series.slice(0, LIMIT);

  console.log(`  Séries a processar: ${series.length}\n`);
  if (!series.length) { console.log("Nada a importar."); await prisma.$disconnect(); return; }

  let totalOk = 0, totalSkipped = 0, totalFailed = 0;

  for (let i = 0; i < series.length; i++) {
    const { ok, skipped, failed } = await importSerie(series[i], i + 1, series.length);
    totalOk      += ok;
    totalSkipped += skipped;
    totalFailed  += failed;
  }

  console.log(`\n=== Concluído ===`);
  console.log(`  Episódios importados: ${totalOk}`);
  console.log(`  Séries puladas:       ${totalSkipped}`);
  console.log(`  Séries com erro:      ${totalFailed}\n`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
