/**
 * sync-webcine.ts
 * Importa catálogo completo do WebCine (webcinevs2.com) para o banco SureEdge.
 *
 * Uso:
 *   npx tsx scripts/sync-webcine.ts                          # dry run
 *   npx tsx scripts/sync-webcine.ts --import                 # importa tudo
 *   npx tsx scripts/sync-webcine.ts --import --tipo filmes
 *   npx tsx scripts/sync-webcine.ts --import --tipo series
 *   npx tsx scripts/sync-webcine.ts --import --tipo animes
 *   npx tsx scripts/sync-webcine.ts --import --fix-episodes  # busca eps p/ séries sem episódios
 *   npx tsx scripts/sync-webcine.ts --import --concurrency 8
 *
 * Env vars necessárias (no .env):
 *   DATABASE_URL, DIRECT_URL
 *   WEBCINE_REFRESH_TOKEN, WEBCINE_DEVICE_ID, WEBCINE_PROFILE_ID
 */

import { PrismaClient } from "@prisma/client";
try { require("dotenv").config(); } catch { /* sem dotenv, usa vars do ambiente */ }

const prisma = new PrismaClient();

const args        = process.argv.slice(2);
const getArg      = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const hasFlag     = (f: string) => args.includes(f);

const DO_IMPORT   = hasFlag("--import");
const TIPO        = getArg("--tipo") ?? "todos";
const CONCURRENCY = Number(getArg("--concurrency") ?? "5");
const FIX_EPS     = hasFlag("--fix-episodes"); // busca eps para séries já no banco sem episódios
const DB_BATCH    = 200;

const UA           = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";
const CATALOG_BASE = "https://utxptx-api.b-cdn.net/api/v1/catalog";
const WEBCINE_API  = "https://webcinevs2.com/api";

// ── Auth ──────────────────────────────────────────────────────────────────────

let tokenCache: { token: string; exp: number } | null = null;
let tokenRefreshing: Promise<string> | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp - 300_000) return tokenCache.token;
  if (tokenRefreshing) return tokenRefreshing;

  tokenRefreshing = (async () => {
    const refreshToken = process.env.WEBCINE_REFRESH_TOKEN;
    const deviceId = process.env.WEBCINE_DEVICE_ID ?? "";
    if (!refreshToken) throw new Error("WEBCINE_REFRESH_TOKEN não configurado");

    // Retenta até 3x com backoff em caso de timeout
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${WEBCINE_API}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-device-id": deviceId, "User-Agent": UA },
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const token = data.token as string;
        if (!token) throw new Error("campo token ausente");
        try {
          const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
          tokenCache = { token, exp: (payload.exp as number) * 1000 };
        } catch {
          tokenCache = { token, exp: Date.now() + 25 * 24 * 3600_000 };
        }
        return token;
      } catch (e: any) {
        if (attempt === 3) throw new Error(`Refresh token falhou (3 tentativas): ${e.message}`);
        console.warn(`  ⚠️  Refresh tentativa ${attempt} falhou (${e.message}), aguardando ${attempt * 2}s...`);
        await sleep(attempt * 2000);
      }
    }
    throw new Error("unreachable");
  })().finally(() => { tokenRefreshing = null; });

  return tokenRefreshing;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-device-id": process.env.WEBCINE_DEVICE_ID ?? "",
    Accept: "application/json",
    "User-Agent": UA,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function chunks<T>(arr: T[], size: number): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < arr.length; i += size) r.push(arr.slice(i, i + size));
  return r;
}

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

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface CatalogItem {
  id: number;
  title: string;
  original_title?: string;
  description?: string;
  poster?: string;
  backdrop?: string;
  logo?: string;
  year?: number;
  duration?: number;
  rating_avg?: number;
  tmdb_id?: number;
  type: "movie" | "series" | "anime";
  genres?: { id: number; name: string }[];
}

// ── Catálogo ──────────────────────────────────────────────────────────────────

async function fetchAllPages(endpoint: string): Promise<CatalogItem[]> {
  const firstRes = await fetch(`${CATALOG_BASE}/${endpoint}?page=1`, { signal: AbortSignal.timeout(15000) });
  if (!firstRes.ok) throw new Error(`HTTP ${firstRes.status} em ${endpoint}`);
  const firstData = await firstRes.json();
  const lastPage: number = firstData.last_page ?? 1;
  const total: number = firstData.total ?? 0;
  const all: CatalogItem[] = [...(firstData.data ?? [])];

  console.log(`  Total no catálogo: ${total} itens (${lastPage} páginas)`);

  const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
  await pool(pages, CONCURRENCY, async (page) => {
    try {
      const res = await fetch(`${CATALOG_BASE}/${endpoint}?page=${page}`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) all.push(...((await res.json()).data ?? []));
    } catch { /* ignora página com erro */ }
    if (page % 100 === 0) process.stdout.write(`\r  Carregando catálogo... ${all.length}/${total}`);
  });

  console.log(`\r  Catálogo carregado: ${all.length} itens                    `);
  return all;
}

// ── URLs do player ────────────────────────────────────────────────────────────

function buildMovieUrl(tmdbId: number, title: string): string {
  return `https://webcinevs2.com/watch?id=${tmdbId}&type=movie&q=${encodeURIComponent(title)}`;
}

function buildEpisodeUrl(tmdbId: number, title: string, season: number, ep: number): string {
  return `https://webcinevs2.com/watch?id=${tmdbId}&type=tv&season=${season}&episode=${ep}&q=${encodeURIComponent(title)}`;
}

// ── Import filmes ─────────────────────────────────────────────────────────────

async function importFilmes() {
  console.log("\n🎬 FILMES");
  const items = await fetchAllPages("movies");

  const existingTmdb = new Set(
    (await prisma.filme.findMany({ where: { tmdbId: { not: null } }, select: { tmdbId: true } })).map((f) => f.tmdbId!),
  );
  const existingIds = new Set(
    (await prisma.filme.findMany({ select: { id: true } })).map((f) => f.id),
  );

  const novos = items.filter(
    (f) => f.tmdb_id && !existingTmdb.has(String(f.tmdb_id)) && !existingIds.has(`wc_${f.id}`),
  );
  console.log(`  Já no banco: ${existingIds.size} | Novos: ${novos.length} | Sem tmdbId (ignorados): ${items.filter((f) => !f.tmdb_id).length}`);

  if (novos.length === 0) { console.log("  ✅ Nenhum filme novo."); return; }
  if (!DO_IMPORT) { console.log("  ℹ️  Rode com --import para salvar."); return; }

  const genMap = new Map<number, string>();
  for (const f of novos) f.genres?.forEach((g) => genMap.set(g.id, g.name));
  for (const b of chunks([...genMap.entries()].map(([id, nome]) => ({ id, nome })), DB_BATCH)) {
    await prisma.genero.createMany({ data: b, skipDuplicates: true });
  }

  let ok = 0;
  for (const batch of chunks(novos, DB_BATCH)) {
    await prisma.filme.createMany({
      skipDuplicates: true,
      data: batch.map((f) => ({
        id: `wc_${f.id}`,
        tmdbId: String(f.tmdb_id),
        titulo: f.title,
        tituloOriginal: f.original_title ?? null,
        poster: f.poster ?? null,
        background: f.backdrop ?? null,
        sinopse: f.description ?? null,
        ano: f.year ?? null,
        nota: f.rating_avg ?? null,
        duracao: f.duration ?? null,
        urlDub: buildMovieUrl(f.tmdb_id!, f.title),
      })),
    });
    const fgRows = batch.flatMap((f) => (f.genres ?? []).map((g) => ({ filmeId: `wc_${f.id}`, generoId: g.id })));
    if (fgRows.length > 0) await prisma.filmeGenero.createMany({ data: fgRows, skipDuplicates: true });
    ok += batch.length;
    process.stdout.write(`\r  ${ok}/${novos.length} filmes...`);
  }
  console.log(`\n  ✅ ${ok} filmes importados!`);
}

// ── Fetch de episódios via API WebCine ────────────────────────────────────────
// Usada tanto para séries novas quanto para o modo --fix-episodes.

interface EpTarget {
  wcId: number;        // ID webcine (número)
  serieId: string;     // ID no banco ("wc_XXXX")
  tmdbId: number;
  titulo: string;
}

async function fetchAndSaveEpisodes(targets: EpTarget[]) {
  if (targets.length === 0) { console.log("  Nenhuma série para buscar episódios."); return; }

  console.log(`  🔄 Buscando episódios para ${targets.length} séries... (concurrency=${CONCURRENCY})`);

  let token = await getToken();
  const profileId = process.env.WEBCINE_PROFILE_ID ?? "";

  const existingEpIds = new Set(
    (await prisma.episodio.findMany({ select: { id: true } })).map((e) => e.id),
  );

  let done = 0;
  let epTotal = 0;
  let erros = 0;
  const maxTempMap = new Map<string, number>();

  await pool(targets, CONCURRENCY, async (t) => {
    try {
      token = await getToken();
      const res = await fetch(
        `${WEBCINE_API}/series/${t.wcId}?profile_id=${profileId}`,
        { headers: authHeaders(token), signal: AbortSignal.timeout(20000) },
      );
      if (!res.ok) { erros++; done++; return; }

      const detail = await res.json();
      const seasons = (detail.seasons ?? []) as Array<{
        number: number;
        episodes: Array<{ id: number; number: number; name?: string; title?: string }>;
      }>;

      if (seasons.length > 0) {
        maxTempMap.set(t.serieId, Math.max(...seasons.map((s) => s.number)));
      }

      const epRows = seasons.flatMap((season) =>
        (season.episodes ?? [])
          .filter((ep) => !existingEpIds.has(`wc_ep_${ep.id}`))
          .map((ep) => ({
            id: `wc_ep_${ep.id}`,
            serieId: t.serieId,
            temporada: season.number,
            numeroEp: ep.number,
            titulo: ep.name ?? ep.title ?? null,
            urlDub: buildEpisodeUrl(t.tmdbId, t.titulo, season.number, ep.number),
          })),
      );

      if (epRows.length > 0) {
        for (const batch of chunks(epRows, DB_BATCH)) {
          await prisma.episodio.createMany({ data: batch, skipDuplicates: true });
        }
        epTotal += epRows.length;
        epRows.forEach((e) => existingEpIds.add(e.id));
      }
    } catch { erros++; }

    done++;
    if (done % 20 === 0 || done === targets.length) {
      process.stdout.write(`\r  ${done}/${targets.length} séries | ${epTotal} eps | erros: ${erros}   `);
    }
  });

  // Atualiza campo temporadas
  for (const [id, temporadas] of maxTempMap) {
    await prisma.serie.update({ where: { id }, data: { temporadas } }).catch(() => {});
  }

  console.log(`\n  ✅ ${epTotal} episódios importados! (erros: ${erros})`);
}

// ── Fix-episodes: séries wc_ sem nenhum episódio ──────────────────────────────

async function fixEpisodes(tipo?: "serie" | "anime") {
  const label = tipo ?? "serie+anime";
  console.log(`\n🔧 FIX-EPISODES (${label})`);

  const where = tipo ? { id: { startsWith: "wc_" }, tipo } : { id: { startsWith: "wc_" } };

  const semEps = await prisma.serie.findMany({
    where: { ...where, episodios: { none: {} } },
    select: { id: true, tmdbId: true, titulo: true },
  });

  console.log(`  Séries wc_ sem episódios: ${semEps.length}`);
  if (semEps.length === 0) { console.log("  ✅ Todas as séries já têm episódios."); return; }

  const targets: EpTarget[] = semEps
    .filter((s) => s.tmdbId)
    .map((s) => ({
      wcId: Number(s.id.replace("wc_", "")),
      serieId: s.id,
      tmdbId: Number(s.tmdbId),
      titulo: s.titulo,
    }));

  await fetchAndSaveEpisodes(targets);
}

// ── Import séries/animes ──────────────────────────────────────────────────────

async function importSeriesTipo(catalogEndpoint: "series" | "animes", tipo: "serie" | "anime") {
  const emoji = tipo === "anime" ? "🎌" : "📺";
  const label = tipo === "anime" ? "animes" : "séries";
  console.log(`\n${emoji} ${label.toUpperCase()}`);

  const items = await fetchAllPages(catalogEndpoint);

  const existingTmdb = new Set(
    (await prisma.serie.findMany({ where: { tmdbId: { not: null } }, select: { tmdbId: true } })).map((s) => s.tmdbId!),
  );
  const existingIds = new Set(
    (await prisma.serie.findMany({ select: { id: true } })).map((s) => s.id),
  );

  const novos = items.filter(
    (s) => s.tmdb_id && !existingTmdb.has(String(s.tmdb_id)) && !existingIds.has(`wc_${s.id}`),
  );
  console.log(`  Já no banco: ${existingIds.size} | Novos: ${novos.length} | Sem tmdbId (ignorados): ${items.filter((s) => !s.tmdb_id).length}`);

  if (novos.length > 0) {
    if (!DO_IMPORT) { console.log("  ℹ️  Rode com --import para salvar."); }
    else {
      // Gêneros
      const genMap = new Map<number, string>();
      for (const s of novos) s.genres?.forEach((g) => genMap.set(g.id, g.name));
      for (const b of chunks([...genMap.entries()].map(([id, nome]) => ({ id, nome })), DB_BATCH)) {
        await prisma.genero.createMany({ data: b, skipDuplicates: true });
      }

      // Séries metadata
      for (const batch of chunks(novos, DB_BATCH)) {
        await prisma.serie.createMany({
          skipDuplicates: true,
          data: batch.map((s) => ({
            id: `wc_${s.id}`,
            tmdbId: String(s.tmdb_id),
            titulo: s.title,
            tituloOriginal: s.original_title ?? null,
            poster: s.poster ?? null,
            background: s.backdrop ?? null,
            sinopse: s.description ?? null,
            ano: s.year ?? null,
            nota: s.rating_avg ?? null,
            tipo,
          })),
        });
        const sgRows = batch.flatMap((s) => (s.genres ?? []).map((g) => ({ serieId: `wc_${s.id}`, generoId: g.id })));
        if (sgRows.length > 0) await prisma.serieGenero.createMany({ data: sgRows, skipDuplicates: true });
      }
      console.log(`  ✅ ${novos.length} ${label} (metadados)`);
    }
  }

  if (!DO_IMPORT) return;

  // Episódios: séries novas + séries já no banco que ficaram sem eps (ex: crash anterior)
  await fixEpisodes(tipo);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("══════════════════════════════════════════");
  console.log("   WebCine Sync — SureEdge");
  console.log(`   Modo: ${DO_IMPORT ? "IMPORT" : "DRY RUN"} | Tipo: ${TIPO}${FIX_EPS ? " | fix-episodes" : ""} | Concurrency: ${CONCURRENCY}`);
  console.log("══════════════════════════════════════════");

  if (!DO_IMPORT) {
    console.log(`
Sem --import, nada é salvo.

Uso:
  npx tsx scripts/sync-webcine.ts --import
  npx tsx scripts/sync-webcine.ts --import --tipo filmes
  npx tsx scripts/sync-webcine.ts --import --tipo series
  npx tsx scripts/sync-webcine.ts --import --tipo animes
  npx tsx scripts/sync-webcine.ts --import --fix-episodes     # só busca eps p/ séries sem eps
  npx tsx scripts/sync-webcine.ts --import --concurrency 10
    `);
  }

  const start = Date.now();

  // Modo fix-episodes sem tipo: conserta todas as séries wc_ sem eps
  if (FIX_EPS && !["series", "animes"].includes(TIPO)) {
    if (DO_IMPORT) await fixEpisodes();
    const mins = ((Date.now() - start) / 60000).toFixed(1);
    console.log(`\n✅ Concluído em ${mins} minutos`);
    await prisma.$disconnect();
    return;
  }

  if (TIPO === "filmes" || TIPO === "todos") await importFilmes();
  if (TIPO === "series" || TIPO === "todos") await importSeriesTipo("series", "serie");
  if (TIPO === "animes"  || TIPO === "todos") await importSeriesTipo("animes",  "anime");

  const mins = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`\n✅ Concluído em ${mins} minutos`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
