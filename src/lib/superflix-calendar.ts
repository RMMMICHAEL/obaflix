import { prisma } from "@/lib/prisma";
import { getSerie, getTVImages, getTVSeasonDetails, pickBackdrop, pickLogo, type TmdbTV } from "@/lib/tmdb";

const CALENDAR_URL = "https://superflixapi.beer/calendario.php";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

interface SuperflixCalendarItem {
  title?: string;
  episode?: string;
  season?: number | string;
  number?: number | string;
  air_date?: string;
  type?: number | string;
  tmdb_id?: string | number;
  imdb_id?: string;
  poster?: string;
  backdrop?: string;
  status?: string;
}

export interface SuperflixSyncResult {
  encontrados: number;
  disponiveis: number;
  seriesAdicionadas: number;
  episodiosAdicionados: number;
  seriesCompletadas: number;
  ignorados: number;
  erros: string[];
}

export type SuperflixProgress = (message: string) => void;
export interface SuperflixSyncOptions { backfillExisting?: boolean; }

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function episodeRowsFor(
  tmdbId: string,
  serieId: string,
  items: SuperflixCalendarItem[],
) {
  const unique = new Map<string, SuperflixCalendarItem>();
  for (const item of items) unique.set(`${Number(item.season)}:${Number(item.number)}`, item);
  return [...unique.values()].map((item) => {
    const temporada = Number(item.season);
    const numeroEp = Number(item.number);
    return {
      id: `${serieId}-t${temporada}e${numeroEp}`,
      serieId,
      temporada,
      numeroEp,
      titulo: item.episode || null,
      urlDub: `https://superflixapi.beer/serie/${encodeURIComponent(tmdbId)}/${temporada}/${numeroEp}`,
    };
  });
}

async function fullSeriesEpisodeRows(
  tmdbId: string,
  serieId: string,
  details: TmdbTV | null,
  markLatestRecent = false,
) {
  const seasonCount = details?.number_of_seasons ?? 0;
  if (seasonCount < 1) return [];
  const seasons = await Promise.all(
    Array.from({ length: seasonCount }, (_, index) => getTVSeasonDetails(tmdbId, index + 1)),
  );
  const today = new Date().toISOString().slice(0, 10);
  const rows = seasons.flatMap((season) => (season?.episodes ?? []))
    .filter((episode) => !episode.air_date || episode.air_date <= today)
    .map((episode) => ({
      id: `${serieId}-t${episode.season_number}e${episode.episode_number}`,
      serieId,
      temporada: episode.season_number,
      numeroEp: episode.episode_number,
      titulo: episode.name || `Episódio ${episode.episode_number}`,
      thumbnail: absoluteImage(episode.still_path || undefined, "w500"),
      urlDub: `https://superflixapi.beer/serie/${encodeURIComponent(tmdbId)}/${episode.season_number}/${episode.episode_number}`,
      createdAt: episode.air_date ? new Date(`${episode.air_date}T12:00:00.000Z`) : new Date(),
    }));
  if (markLatestRecent && rows.length) {
    rows.sort((a, b) => a.temporada - b.temporada || a.numeroEp - b.numeroEp);
    rows[rows.length - 1].createdAt = new Date();
  }
  return rows;
}

function absoluteImage(path: string | undefined, size: "w500" | "original") {
  if (!path) return null;
  return path.startsWith("http") ? path : `${IMAGE_BASE}/${size}${path}`;
}

function seriesType(genres: number[], originalLanguage?: string) {
  if (genres.includes(16) && originalLanguage === "ja") return "anime";
  if (genres.includes(16)) return "desenho";
  return "serie";
}

async function fetchCalendar(): Promise<SuperflixCalendarItem[]> {
  const response = await fetch(CALENDAR_URL, {
    headers: { Accept: "application/json", "User-Agent": "Obaflix-Sync/1.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SuperFlix respondeu HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("Resposta inválida do calendário da SuperFlix");
  return data as SuperflixCalendarItem[];
}

/**
 * Importa somente itens que a SuperFlix marca como disponíveis. Nunca remove nem
 * sobrescreve conteúdo: séries são comparadas por TMDB ID e episódios pela chave
 * (série, temporada, número).
 */
export async function syncSuperflixCalendar(
  onProgress: SuperflixProgress = () => {},
  options: SuperflixSyncOptions = {},
): Promise<SuperflixSyncResult> {
  onProgress("Baixando calendário...");
  const calendar = await fetchCalendar();
  const result: SuperflixSyncResult = {
    encontrados: calendar.length,
    disponiveis: 0,
    seriesAdicionadas: 0,
    episodiosAdicionados: 0,
    seriesCompletadas: 0,
    ignorados: 0,
    erros: [],
  };

  // "Hoje", "Atrasado" e "Futuro" não garantem que o player já esteja disponível.
  const available = calendar.filter((item) => item.status === "Atualizado");
  result.disponiveis = available.length;

  const byTmdb = new Map<string, SuperflixCalendarItem[]>();
  for (const item of available) {
    const tmdbId = String(item.tmdb_id ?? "").trim();
    const season = Number(item.season);
    const episode = Number(item.number);
    if (!tmdbId || !Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
      result.ignorados++;
      continue;
    }
    const items = byTmdb.get(tmdbId) ?? [];
    items.push(item);
    byTmdb.set(tmdbId, items);
  }

  const tmdbIds = [...byTmdb.keys()];
  onProgress(`${available.length} episódios disponíveis em ${tmdbIds.length} séries. Consultando o banco...`);
  const existingSeries = await prisma.serie.findMany({
    where: { tmdbId: { in: tmdbIds } },
    select: { id: true, tmdbId: true },
  });
  const seriesIds = new Map(existingSeries.map((serie) => [serie.tmdbId!, serie.id]));

  const newSeriesCount = tmdbIds.filter((tmdbId) => !seriesIds.has(tmdbId)).length;
  onProgress(`${existingSeries.length} séries já existem; ${newSeriesCount} precisam ser cadastradas.`);

  // Completa primeiro as séries existentes. Se o processo for interrompido durante
  // o cadastro das novas, o catálogo atual não fica aguardando o fim da execução.
  const existingEpisodeRows = [...byTmdb.entries()].flatMap(([tmdbId, items]) => {
    const serieId = seriesIds.get(tmdbId);
    return serieId ? episodeRowsFor(tmdbId, serieId, items) : [];
  });
  const existingBatches = chunks(existingEpisodeRows, 400);
  onProgress(`Atualizando séries existentes em ${existingBatches.length} lotes...`);
  for (let index = 0; index < existingBatches.length; index++) {
    const batch = existingBatches[index];
    const inserted = await prisma.episodio.createMany({ data: batch, skipDuplicates: true });
    result.episodiosAdicionados += inserted.count;
    result.ignorados += batch.length - inserted.count;
    onProgress(`Lote existente ${index + 1}/${existingBatches.length}: ${inserted.count} episódios novos.`);
  }

  // Reparo opcional das séries criadas por versões antigas do importador. No uso
  // normal, séries existentes recebem somente os episódios novos do calendário.
  if (options.backfillExisting) {
    const repairTargets = existingSeries.filter((serie) => serie.id.startsWith("sf_"));
    onProgress(`Reparo completo solicitado para ${repairTargets.length} séries SuperFlix...`);
    for (let index = 0; index < repairTargets.length; index++) {
      const serie = repairTargets[index];
      try {
        const details = await getSerie(serie.tmdbId!);
        const rows = await fullSeriesEpisodeRows(serie.tmdbId!, serie.id, details);
        const inserted = rows.length
          ? await prisma.episodio.createMany({ data: rows, skipDuplicates: true })
          : { count: 0 };
        result.episodiosAdicionados += inserted.count;
        result.ignorados += rows.length - inserted.count;
        result.seriesCompletadas++;
        onProgress(`Reparo ${index + 1}/${repairTargets.length}: ${serie.tmdbId} (+${inserted.count} episódios)`);
      } catch (error) {
        result.erros.push(`reparo ${serie.tmdbId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  let processedSeries = 0;
  for (const [tmdbId, items] of byTmdb) {
    if (seriesIds.has(tmdbId)) continue;
    try {
      let serieId: string;
        const sample = items[0];
        const [details, images] = await Promise.all([
          getSerie(tmdbId),
          getTVImages(tmdbId).catch(() => null),
        ]);
        const genreIds = details?.genres?.map((genre) => genre.id) ?? [];
        serieId = `sf_${tmdbId}`;

        const created = await prisma.serie.create({
          data: {
            id: serieId,
            tmdbId,
            imdbId: sample.imdb_id || null,
            titulo: details?.name || sample.title || `Série ${tmdbId}`,
            tituloOriginal: details?.name || null,
            poster: absoluteImage(details?.poster_path || sample.poster, "w500"),
            background: pickBackdrop(images) || absoluteImage(details?.backdrop_path || sample.backdrop, "original"),
            logo: pickLogo(images),
            sinopse: details?.overview || null,
            ano: details?.first_air_date ? Number(details.first_air_date.slice(0, 4)) || null : null,
            nota: details?.vote_average ?? null,
            temporadas: details?.number_of_seasons ?? Math.max(...items.map((item) => Number(item.season))),
            tipo: seriesType(genreIds, details?.original_language),
            originalLanguage: details?.original_language || null,
          },
        });
        serieId = created.id;
        seriesIds.set(tmdbId, serieId);
        result.seriesAdicionadas++;
        onProgress(`Nova série: ${created.titulo} (${result.seriesAdicionadas}/${newSeriesCount})`);

        if (details?.genres?.length) {
          await prisma.genero.createMany({
            data: details.genres.map((genre) => ({ id: genre.id, nome: genre.name })),
            skipDuplicates: true,
          });
          await prisma.serieGenero.createMany({
            data: details.genres.map((genre) => ({ serieId: created.id, generoId: genre.id })),
            skipDuplicates: true,
          });
        }

        // Persiste os episódios imediatamente; a série não fica vazia caso uma
        // execução longa seja interrompida antes de processar as demais.
        // Série nova recebe todo o catálogo já exibido pelo TMDB; o calendário
        // sozinho contém apenas lançamentos recentes e deixaria temporadas antigas faltando.
        const fullRows = await fullSeriesEpisodeRows(tmdbId, serieId, details, true);
        const rows = fullRows.length ? fullRows : episodeRowsFor(tmdbId, serieId, items);
        const inserted = await prisma.episodio.createMany({ data: rows, skipDuplicates: true });
        result.episodiosAdicionados += inserted.count;
        result.ignorados += rows.length - inserted.count;
        onProgress(`  ${inserted.count} episódios adicionados a ${created.titulo}.`);

    } catch (error) {
      result.erros.push(`${tmdbId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    processedSeries++;
    if (processedSeries % 25 === 0) onProgress(`Novas séries processadas: ${processedSeries}/${newSeriesCount}`);
  }

  onProgress("Sincronização concluída.");
  return result;
}
