/**
 * import-embedmovies.mjs
 * Scrape embedmovies.org/series (163 pages) e insere no banco
 * as séries que ainda não existem (por tmdbId).
 *
 * Usage:
 *   node scripts/import-embedmovies.mjs
 *   node scripts/import-embedmovies.mjs --dry-run        (não grava no banco)
 *   node scripts/import-embedmovies.mjs --start 10       (começa da página 10)
 *   node scripts/import-embedmovies.mjs --end 50         (para na página 50)
 *   node scripts/import-embedmovies.mjs --skip-scrape    (usa cache .scrape-cache.json)
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ── Carrega .env manualmente ───────────────────────────────────────────────
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
const flag = (f) => args.includes(f);
const argVal = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

const DRY_RUN    = flag("--dry-run");
const SKIP_SCRAPE = flag("--skip-scrape");
const START_PAGE = Number(argVal("--start") ?? 1);
const END_PAGE   = Number(argVal("--end")   ?? 163);
const CACHE_FILE = resolve(process.cwd(), "scripts/.scrape-cache.json");

const SCRAPE_DELAY_MS = 350; // ~2.8 req/s — gentil com o servidor
const TMDB_DELAY_MS   = 220; // ~4.5 req/s — bem abaixo do limite de 50/10s

const prisma = new PrismaClient({ log: [] });

// ── Helpers ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectTipo(genres = [], countries = []) {
  const ids = genres.map((g) => g.id);
  if (ids.includes(16) && countries.includes("JP")) return "anime";
  if (ids.includes(16)) return "desenho";
  return "serie";
}

async function tmdb(path) {
  try {
    const url = `https://api.themoviedb.org/3${path}${path.includes("?") ? "&" : "?"}api_key=${TMDB_KEY}&language=pt-BR`;
    const r = await fetch(url);
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

// ── Scrape embedmovies.org ─────────────────────────────────────────────────
async function scrapePage(page) {
  const url = `https://embedmovies.org/series?page=${page}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const items = [];
  // Parseia artigo por artigo para garantir alinhamento dos dados
  for (const m of html.matchAll(/<article>([\s\S]*?)<\/article>/g)) {
    const block = m[1];

    // TMDB ID — de openEmbed('https://myembed.biz/serie/{id}')
    const embedM = block.match(/openEmbed\('https:\/\/myembed\.biz\/serie\/(\d+)'\)/);
    if (!embedM) continue;
    const tmdbId = embedM[1];

    // Poster e título — <img data-src="..." alt="..." class="poster">
    const imgM = block.match(/data-src="([^"]+)"[^>]*alt="([^"]+)"/);
    const poster = imgM?.[1] ?? null;
    const title  = imgM?.[2] ?? "";

    // Ano — primeiro <span> com 4 dígitos dentro de .meta
    const yearM = block.match(/<span>(\d{4})<\/span>/);
    const year  = yearM ? Number(yearM[1]) : null;

    // IMDB ID (opcional, nem todas as séries têm)
    const imdbM = block.match(/imdb\.com\/title\/(tt\d+)/);
    const imdbId = imdbM?.[1] ?? null;

    items.push({ tmdbId, title, poster, year, imdbId });
  }
  return items;
}

async function scrapeAll() {
  if (SKIP_SCRAPE && existsSync(CACHE_FILE)) {
    console.log(`Usando cache: ${CACHE_FILE}`);
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  }

  const map = new Map(); // tmdbId → item (dedup)
  let errors = 0;

  for (let p = START_PAGE; p <= END_PAGE; p++) {
    process.stdout.write(`\r  Scraping página ${p}/${END_PAGE} — ${map.size} séries encontradas  `);
    try {
      const items = await scrapePage(p);
      for (const item of items) {
        if (!map.has(item.tmdbId)) map.set(item.tmdbId, item);
      }
    } catch (e) {
      errors++;
      process.stdout.write(`\n  ⚠  Página ${p}: ${e.message}\n`);
    }
    if (p < END_PAGE) await sleep(SCRAPE_DELAY_MS);
  }

  const result = [...map.values()];
  console.log(`\n  Total: ${result.size ?? result.length} séries únicas, ${errors} erros de página`);
  writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));
  return result;
}

// ── Importa para o banco ───────────────────────────────────────────────────
async function importSeries(scraped) {
  // IDs já existentes no banco
  const existing = await prisma.serie.findMany({ select: { tmdbId: true } });
  const existingIds = new Set(existing.map((s) => s.tmdbId).filter(Boolean));
  console.log(`  Banco: ${existingIds.size} séries existentes`);

  const toImport = scraped.filter((s) => !existingIds.has(s.tmdbId));
  console.log(`  Para importar: ${toImport.length} séries novas\n`);

  if (toImport.length === 0) { console.log("Nada a importar."); return; }
  if (DRY_RUN) { console.log("[DRY-RUN] Nenhuma gravação realizada."); return; }

  let ok = 0, skipped = 0, failed = 0;

  for (const s of toImport) {
    const idx = ok + skipped + failed + 1;
    process.stdout.write(`\r  [${idx}/${toImport.length}] OK:${ok} Skip:${skipped} Err:${failed}  `);

    // Busca detalhes completos no TMDB
    const details = await tmdb(`/tv/${s.tmdbId}`);
    if (!details?.id) {
      failed++;
      await sleep(TMDB_DELAY_MS);
      continue;
    }

    const tipo = detectTipo(details.genres ?? [], details.origin_country ?? []);

    // Upsert gêneros
    for (const g of details.genres ?? []) {
      await prisma.genero.upsert({
        where:  { id: g.id },
        update: { nome: g.name },
        create: { id: g.id, nome: g.name },
      }).catch(() => {});
    }

    // Upsert série (skipDuplicates via upsert — não sobrescreve se já existir)
    try {
      await prisma.serie.upsert({
        where: { id: String(details.id) },
        update: {}, // existe por tmdbId verificado acima, mas pode diferir pelo id
        create: {
          id:             String(details.id),
          tmdbId:         String(details.id),
          titulo:         details.name ?? s.title,
          tituloOriginal: details.original_name ?? null,
          poster:         details.poster_path
                            ? `https://image.tmdb.org/t/p/w500${details.poster_path}`
                            : (s.poster ?? null),
          background:     details.backdrop_path
                            ? `https://image.tmdb.org/t/p/original${details.backdrop_path}`
                            : null,
          sinopse:        details.overview ?? null,
          ano:            details.first_air_date
                            ? Number(details.first_air_date.slice(0, 4))
                            : (s.year ?? null),
          nota:           details.vote_average ?? null,
          temporadas:     details.number_of_seasons ?? null,
          tipo,
        },
      });

      // Vincula gêneros
      for (const g of details.genres ?? []) {
        await prisma.serieGenero.upsert({
          where:  { serieId_generoId: { serieId: String(details.id), generoId: g.id } },
          update: {},
          create: { serieId: String(details.id), generoId: g.id },
        }).catch(() => {});
      }

      ok++;
    } catch (e) {
      failed++;
      process.stdout.write(`\n  ✗ ${s.tmdbId} ${s.title}: ${e.message.slice(0, 80)}\n`);
    }

    await sleep(TMDB_DELAY_MS);
  }

  console.log(`\n\n  ✓ Importadas: ${ok}  Ignoradas: ${skipped}  Falhas: ${failed}`);
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== import-embedmovies ===`);
  console.log(`Páginas: ${START_PAGE}–${END_PAGE}  |  DRY-RUN: ${DRY_RUN}  |  SKIP-SCRAPE: ${SKIP_SCRAPE}\n`);

  console.log("1/2  Scraping embedmovies.org...");
  const scraped = await scrapeAll();

  console.log("\n2/2  Importando para o banco...");
  await importSeries(scraped);

  await prisma.$disconnect();
  console.log("\nConcluído.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
