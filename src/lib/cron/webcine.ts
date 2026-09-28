/**
 * Sync do catalogo WebCine.
 *
 * Vivia em src/app/api/cron/sync-webcine/route.ts com cron proprio. O plano
 * Hobby aceita 2 cron jobs, entao a logica saiu do route handler e virou funcao:
 * roda dentro de /api/cron/sync, na mesma cadencia diaria de antes e sem
 * invocacao extra. O route handler continua existindo, so para disparo manual.
 */
import { prisma } from "@/lib/prisma";
import { mergeProviderUrl, normalizeTmdbId } from "@/lib/catalog-ingest";

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

async function syncFilmes(log: string[]): Promise<{ novos: number; completados: number }> {
  const items = await fetchCatalogPage("movies");
  const validos = items.filter((item) => normalizeTmdbId(item.tmdb_id));
  if (validos.length === 0) return { novos: 0, completados: 0 };

  const tmdbIds = validos.map((item) => normalizeTmdbId(item.tmdb_id)!);
  const wcIds = validos.map((item) => `wc_${item.id}`);
  const existentes = await prisma.filme.findMany({
    where: { OR: [{ tmdbId: { in: tmdbIds } }, { id: { in: wcIds } }] },
    select: { id: true, tmdbId: true, urlDub: true },
    orderBy: { id: "asc" },
  });

  // A identidade do catálogo é o TMDB, não o ID interno de cada provedor. Um
  // stub tmdb_* ou um item Megafrix existente é completado com o espelho WebCine
  // em vez de nascer um segundo card wc_* para o mesmo filme.
  const porTmdb = new Map<string, (typeof existentes)[number]>();
  for (const existente of existentes) {
    const tmdbId = normalizeTmdbId(existente.tmdbId);
    if (tmdbId && !porTmdb.has(tmdbId)) porTmdb.set(tmdbId, existente);
  }
  const porId = new Map(existentes.map((item) => [item.id, item]));
  const novos = validos.filter((item) => {
    const tmdbId = normalizeTmdbId(item.tmdb_id)!;
    return !porTmdb.has(tmdbId) && !porId.has(`wc_${item.id}`);
  });

  // Gêneros de todos os itens, pois um stub convertido em título reproduzível
  // também precisa ganhar as relações que não tinha.
  const genMap = new Map<number, string>();
  for (const f of validos) f.genres?.forEach((g) => genMap.set(g.id, g.name));
  if (genMap.size > 0) {
    await prisma.genero.createMany({
      data: [...genMap.entries()].map(([id, nome]) => ({ id, nome })),
      skipDuplicates: true,
    });
  }

  if (novos.length > 0) {
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
  }

  // Refaz o mapa depois da criação para que toda atualização use o ID canônico
  // efetivamente persistido.
  const canonicos = await prisma.filme.findMany({
    where: { tmdbId: { in: tmdbIds } },
    select: { id: true, tmdbId: true, urlDub: true },
    orderBy: { id: "asc" },
  });
  const canonicoPorTmdb = new Map<string, (typeof canonicos)[number]>();
  for (const filme of canonicos) {
    const tmdbId = normalizeTmdbId(filme.tmdbId);
    if (tmdbId && !canonicoPorTmdb.has(tmdbId)) canonicoPorTmdb.set(tmdbId, filme);
  }

  let completados = 0;
  for (const item of validos) {
    const tmdbId = normalizeTmdbId(item.tmdb_id)!;
    const filme = canonicoPorTmdb.get(tmdbId);
    if (!filme) continue;
    const webcineUrl = buildMovieUrl(item.tmdb_id!, item.title);
    const urlDub = mergeProviderUrl(filme.urlDub, webcineUrl);
    if (urlDub !== filme.urlDub) {
      await prisma.filme.update({ where: { id: filme.id }, data: { urlDub } });
      filme.urlDub = urlDub;
      completados++;
    }
  }

  const fgRows = validos.flatMap((f) => {
    const filmeId = canonicoPorTmdb.get(normalizeTmdbId(f.tmdb_id)!)?.id;
    return filmeId ? (f.genres ?? []).map((g) => ({ filmeId, generoId: g.id })) : [];
  });
  if (fgRows.length > 0) await prisma.filmeGenero.createMany({ data: fgRows, skipDuplicates: true });

  log.push(`🎬 Filmes: ${novos.length} novos | ${completados} identidades existentes receberam WebCine`);
  return { novos: novos.length, completados };
}

// ── Sync séries/animes ─────────────────────────────────────────────────────────

async function syncSeriesTipo(
  endpoint: "series" | "animes",
  tipo: "serie" | "anime",
  log: string[],
): Promise<{ series: number; eps: number; espelhos: number }> {
  const label = tipo === "anime" ? "Animes" : "Séries";
  const items = await fetchCatalogPage(endpoint);
  const validos = items.filter((item) => normalizeTmdbId(item.tmdb_id));
  if (validos.length === 0) return { series: 0, eps: 0, espelhos: 0 };

  const tmdbIds = validos.map((item) => normalizeTmdbId(item.tmdb_id)!);
  const wcIds = validos.map((item) => `wc_${item.id}`);
  const existentes = await prisma.serie.findMany({
    where: { OR: [{ tmdbId: { in: tmdbIds } }, { id: { in: wcIds } }] },
    select: { id: true, tmdbId: true },
    orderBy: { id: "asc" },
  });
  const porTmdb = new Map<string, string>();
  for (const existente of existentes) {
    const tmdbId = normalizeTmdbId(existente.tmdbId);
    if (tmdbId && !porTmdb.has(tmdbId)) porTmdb.set(tmdbId, existente.id);
  }
  const idsExistentes = new Set(existentes.map((serie) => serie.id));
  const novas = validos.filter((item) => {
    const tmdbId = normalizeTmdbId(item.tmdb_id)!;
    return !porTmdb.has(tmdbId) && !idsExistentes.has(`wc_${item.id}`);
  });

  // Gêneros
  const genMap = new Map<number, string>();
  for (const s of validos) s.genres?.forEach((g) => genMap.set(g.id, g.name));
  if (genMap.size > 0) {
    await prisma.genero.createMany({
      data: [...genMap.entries()].map(([id, nome]) => ({ id, nome })),
      skipDuplicates: true,
    });
  }

  if (novas.length > 0) {
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
  }

  const canonicos = await prisma.serie.findMany({
    where: { tmdbId: { in: tmdbIds } },
    select: { id: true, tmdbId: true },
    orderBy: { id: "asc" },
  });
  const canonicoPorTmdb = new Map<string, string>();
  for (const serie of canonicos) {
    const tmdbId = normalizeTmdbId(serie.tmdbId);
    if (tmdbId && !canonicoPorTmdb.has(tmdbId)) canonicoPorTmdb.set(tmdbId, serie.id);
  }

  const sgRows = validos.flatMap((s) => {
    const serieId = canonicoPorTmdb.get(normalizeTmdbId(s.tmdb_id)!);
    return serieId ? (s.genres ?? []).map((g) => ({ serieId, generoId: g.id })) : [];
  });
  if (sgRows.length > 0) await prisma.serieGenero.createMany({ data: sgRows, skipDuplicates: true });

  // Episódios: também revisita séries existentes. Antes, uma falha de token ou
  // detalhe depois do create deixava um wc_* vazio para sempre, pois o próximo
  // cron descartava a série da lista por ela já existir.
  const token = await getToken();
  const profileId = process.env.WEBCINE_PROFILE_ID ?? "";
  let totalEps = 0;
  let totalEspelhos = 0;

  for (const s of validos) {
    const tmdbId = normalizeTmdbId(s.tmdb_id)!;
    const serieId = canonicoPorTmdb.get(tmdbId);
    if (!serieId) continue;
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
          where: { id: serieId },
          data: { temporadas: Math.max(...seasons.map((ss) => ss.number)) },
        }).catch(() => {});
      }

      const sourceRows = seasons.flatMap((season) =>
        (season.episodes ?? []).map((ep) => ({
          temporada: season.number,
          numeroEp: ep.number,
          titulo: ep.name ?? ep.title ?? null,
          urlDub: buildEpisodeUrl(s.tmdb_id!, s.title, season.number, ep.number),
        })),
      );

      if (sourceRows.length > 0) {
        const existentesEp = await prisma.episodio.findMany({
          where: { serieId },
          select: { id: true, temporada: true, numeroEp: true, urlDub: true },
        });
        const porCoordenada = new Map(
          existentesEp.map((ep) => [`${ep.temporada}:${ep.numeroEp}`, ep]),
        );
        const criados: Array<{
          id: string;
          serieId: string;
          temporada: number;
          numeroEp: number;
          titulo: string | null;
          urlDub: string;
        }> = [];

        const pendentes = new Set<string>();
        for (const ep of sourceRows) {
          const key = `${ep.temporada}:${ep.numeroEp}`;
          const existente = porCoordenada.get(key);
          if (!existente) {
            // Mesma coordenada duas vezes na resposta: uma linha só.
            if (pendentes.has(key)) continue;
            pendentes.add(key);
            criados.push({
              id: `${serieId}-t${ep.temporada}e${ep.numeroEp}`,
              serieId,
              temporada: ep.temporada,
              numeroEp: ep.numeroEp,
              titulo: ep.titulo,
              urlDub: ep.urlDub,
            });
            continue;
          }
          const urlDub = mergeProviderUrl(existente.urlDub, ep.urlDub);
          if (urlDub !== existente.urlDub) {
            await prisma.episodio.update({ where: { id: existente.id }, data: { urlDub } });
            existente.urlDub = urlDub;
            totalEspelhos++;
          }
        }

        if (criados.length > 0) {
          const inserted = await prisma.episodio.createMany({ data: criados, skipDuplicates: true });
          totalEps += inserted.count;
        }
      }
    } catch { /* série com erro — continua */ }
  }

  const emoji = tipo === "anime" ? "🎌" : "📺";
  log.push(`${emoji} ${label}: ${novas.length} novas | ${totalEps} eps novos | ${totalEspelhos} eps receberam WebCine`);
  return { series: novas.length, eps: totalEps, espelhos: totalEspelhos };
}

// ── Execucao ───────────────────────────────────────────────────────────────────

export interface ResultadoWebcine {
  totalFilmes: number;
  totalSeries: number;
  totalEps: number;
  /** Filmes existentes que ganharam o espelho WebCine nesta execução. */
  filmesAtualizados: number;
  /** Episódios existentes que ganharam o espelho WebCine nesta execução. */
  episodiosAtualizados: number;
  elapsed: string;
  log: string[];
}

/**
 * As tres coletas continuam em paralelo: sao paginas diferentes da mesma API e
 * o gargalo e a latencia dela, nao o nosso lado. Cada uma faz uma leitura e um
 * createMany em lote, entao o tempo tipico e de poucos segundos.
 */
export async function executarSyncWebcine(log: string[] = []): Promise<ResultadoWebcine> {
  const startedAt = Date.now();

  const [fResult, sResult, aResult] = await Promise.all([
    syncFilmes(log),
    syncSeriesTipo("series", "serie", log),
    syncSeriesTipo("animes", "anime", log),
  ]);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  return {
    totalFilmes: fResult.novos,
    totalSeries: sResult.series + aResult.series,
    totalEps: sResult.eps + aResult.eps,
    filmesAtualizados: fResult.completados,
    episodiosAtualizados: sResult.espelhos + aResult.espelhos,
    elapsed,
    log,
  };
}
