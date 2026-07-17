export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const WEBCINE_API  = "https://webcinevs2.com/api";
const CATALOG_BASE = "https://webcinevs2.com/api/catalog";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";
const DELAY = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Auth ───────────────────────────────────────────────────────────────────────

let tokenCache: { token: string; exp: number } | null = null;

async function getToken(): Promise<string | null> {
  if (tokenCache && Date.now() < tokenCache.exp - 300_000) return tokenCache.token;

  const refreshToken = process.env.WEBCINE_REFRESH_TOKEN;
  const deviceId     = process.env.WEBCINE_DEVICE_ID ?? "";
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${WEBCINE_API}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-device-id": deviceId, "User-Agent": UA },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const token = data.token as string;
    if (!token) return null;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      tokenCache = { token, exp: (payload.exp as number) * 1000 };
    } catch {
      tokenCache = { token, exp: Date.now() + 25 * 24 * 3600_000 };
    }
    return token;
  } catch {
    return null;
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-device-id": process.env.WEBCINE_DEVICE_ID ?? "",
    Accept: "application/json",
    "User-Agent": UA,
  };
}

// ── Catalog types ──────────────────────────────────────────────────────────────

interface CatalogItem {
  id: number;
  title: string;
  original_title?: string;
  description?: string;
  poster?: string;
  backdrop?: string;
  year?: number;
  duration?: number;
  rating_avg?: number;
  tmdb_id?: number;
  genres?: { id: number; name: string }[];
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function fetchCatalogPage(endpoint: string): Promise<CatalogItem[]> {
  const res = await fetch(
    `${CATALOG_BASE}/${endpoint}?page=1&per_page=24&sort=recent`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${endpoint}`);
  const data = await res.json();
  return (data.data ?? data.results ?? (Array.isArray(data) ? data : [])) as CatalogItem[];
}

function buildMovieUrl(tmdbId: number, title: string): string {
  return `https://webcinevs2.com/watch?id=${tmdbId}&type=movie&q=${encodeURIComponent(title)}`;
}

function buildEpisodeUrl(tmdbId: number, title: string, season: number, ep: number): string {
  return `https://webcinevs2.com/watch?id=${tmdbId}&type=tv&season=${season}&episode=${ep}&q=${encodeURIComponent(title)}`;
}

// ── Sync filmes ────────────────────────────────────────────────────────────────

async function syncFilmes(log: string[]): Promise<number> {
  const items = await fetchCatalogPage("movies");
  const wbIds = items.filter((f) => f.tmdb_id).map((f) => `wc_${f.id}`);
  if (wbIds.length === 0) return 0;

  const existing = new Set(
    (await prisma.filme.findMany({ where: { id: { in: wbIds } }, select: { id: true } })).map((f) => f.id),
  );
  const novos = items.filter((f) => f.tmdb_id && !existing.has(`wc_${f.id}`));
  if (novos.length === 0) { log.push("🎬 Filmes: nenhum novo"); return 0; }

  // Gêneros
  const genMap = new Map<number, string>();
  for (const f of novos) f.genres?.forEach((g) => genMap.set(g.id, g.name));
  if (genMap.size > 0) {
    await prisma.genero.createMany({
      data: [...genMap.entries()].map(([id, nome]) => ({ id, nome })),
      skipDuplicates: true,
    });
  }

  await prisma.filme.createMany({
    skipDuplicates: true,
    data: novos.map((f) => ({
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

  const fgRows = novos.flatMap((f) => (f.genres ?? []).map((g) => ({ filmeId: `wc_${f.id}`, generoId: g.id })));
  if (fgRows.length > 0) await prisma.filmeGenero.createMany({ data: fgRows, skipDuplicates: true });

  log.push(`🎬 Filmes: ${novos.length} novos — ${novos.map((f) => f.title).join(", ")}`);
  return novos.length;
}

// ── Sync séries/animes ─────────────────────────────────────────────────────────

async function syncSeriesTipo(
  endpoint: "series" | "animes",
  tipo: "serie" | "anime",
  log: string[],
): Promise<{ series: number; eps: number }> {
  const label = tipo === "anime" ? "Animes" : "Séries";
  const items = await fetchCatalogPage(endpoint);
  const wbIds = items.filter((s) => s.tmdb_id).map((s) => `wc_${s.id}`);
  if (wbIds.length === 0) return { series: 0, eps: 0 };

  const existing = new Set(
    (await prisma.serie.findMany({ where: { id: { in: wbIds } }, select: { id: true } })).map((s) => s.id),
  );
  const novas = items.filter((s) => s.tmdb_id && !existing.has(`wc_${s.id}`));
  if (novas.length === 0) { log.push(`${tipo === "anime" ? "🎌" : "📺"} ${label}: nenhuma nova`); return { series: 0, eps: 0 }; }

  // Gêneros
  const genMap = new Map<number, string>();
  for (const s of novas) s.genres?.forEach((g) => genMap.set(g.id, g.name));
  if (genMap.size > 0) {
    await prisma.genero.createMany({
      data: [...genMap.entries()].map(([id, nome]) => ({ id, nome })),
      skipDuplicates: true,
    });
  }

  // Metadados da série
  await prisma.serie.createMany({
    skipDuplicates: true,
    data: novas.map((s) => ({
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

  const sgRows = novas.flatMap((s) => (s.genres ?? []).map((g) => ({ serieId: `wc_${s.id}`, generoId: g.id })));
  if (sgRows.length > 0) await prisma.serieGenero.createMany({ data: sgRows, skipDuplicates: true });

  // Episódios
  const token = await getToken();
  const profileId = process.env.WEBCINE_PROFILE_ID ?? "";
  let totalEps = 0;

  for (const s of novas) {
    await sleep(DELAY);
    try {
      if (!token) break;
      const res = await fetch(
        `${WEBCINE_API}/series/${s.id}?profile_id=${profileId}`,
        { headers: authHeaders(token), signal: AbortSignal.timeout(20000) },
      );
      if (!res.ok) continue;

      const detail = await res.json();
      const seasons = (detail.seasons ?? []) as Array<{
        number: number;
        episodes: Array<{ id: number; number: number; name?: string; title?: string }>;
      }>;

      if (seasons.length > 0) {
        await prisma.serie.update({
          where: { id: `wc_${s.id}` },
          data: { temporadas: Math.max(...seasons.map((ss) => ss.number)) },
        }).catch(() => {});
      }

      const epRows = seasons.flatMap((season) =>
        (season.episodes ?? []).map((ep) => ({
          id: `wc_ep_${ep.id}`,
          serieId: `wc_${s.id}`,
          temporada: season.number,
          numeroEp: ep.number,
          titulo: ep.name ?? ep.title ?? null,
          urlDub: buildEpisodeUrl(s.tmdb_id!, s.title, season.number, ep.number),
        })),
      );

      if (epRows.length > 0) {
        await prisma.episodio.createMany({ data: epRows, skipDuplicates: true });
        totalEps += epRows.length;
      }
    } catch { /* série com erro — continua */ }
  }

  const emoji = tipo === "anime" ? "🎌" : "📺";
  log.push(`${emoji} ${label}: ${novas.length} novas — ${novas.map((s) => s.title).join(", ")} | ${totalEps} eps`);
  return { series: novas.length, eps: totalEps };
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const authHeader  = req.headers.get("authorization");
  const cronSecret  = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const startedAt = Date.now();
  const log: string[] = [];
  let totalFilmes = 0, totalSeries = 0, totalEps = 0;

  try {
    const [fResult, sResult, aResult] = await Promise.all([
      syncFilmes(log),
      syncSeriesTipo("series", "serie", log),
      syncSeriesTipo("animes", "anime", log),
    ]);

    totalFilmes = fResult;
    totalSeries = sResult.series + aResult.series;
    totalEps    = sResult.eps    + aResult.eps;
  } catch (err: any) {
    log.push(`❌ Erro: ${err.message}`);
    return NextResponse.json({ ok: false, log, error: err.message }, { status: 500 });
  } finally {
    await prisma.$disconnect();
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log.push(`✅ ${elapsed}s — filmes: ${totalFilmes} | séries: ${totalSeries} | eps: ${totalEps}`);

  return NextResponse.json({ ok: true, totalFilmes, totalSeries, totalEps, elapsed, log });
}
