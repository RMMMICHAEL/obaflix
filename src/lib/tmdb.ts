const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";
export const IMG = "https://image.tmdb.org/t/p";
const TMDB_TIMEOUT_MS = 4500;

async function tmdbFetch<T = any>(path: string, opts?: RequestInit): Promise<T | null> {
  if (!TMDB_KEY) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);

  try {
    const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${TMDB_KEY}&language=pt-BR`;
    const res = await fetch(url, {
      ...opts,
      next: { revalidate: 3600, ...opts?.next },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function imgUrl(path: string | null | undefined, size = "w500") {
  if (!path) return "/placeholder.jpg";
  if (path.startsWith("http")) return path;
  return `${IMG}/${size}${path}`;
}

// ── Lists ──────────────────────────────────────────────────────────────────
export const getTrending = (window: "day" | "week" = "week") =>
  tmdbFetch<TmdbPage>(`/trending/all/${window}`);

export const getTrendingMovies = (window: "day" | "week" = "week") =>
  tmdbFetch<TmdbPage>(`/trending/movie/${window}`);

export const getTrendingTV = (window: "day" | "week" = "week") =>
  tmdbFetch<TmdbPage>(`/trending/tv/${window}`);

export const getPopularMovies = (page = 1) =>
  tmdbFetch<TmdbPage>(`/movie/popular?page=${page}`);

export const getPopularTV = (page = 1) =>
  tmdbFetch<TmdbPage>(`/tv/popular?page=${page}`);

export const getTopRatedMovies = (page = 1) =>
  tmdbFetch<TmdbPage>(`/movie/top_rated?page=${page}`);

export const getTopRatedTV = (page = 1) =>
  tmdbFetch<TmdbPage>(`/tv/top_rated?page=${page}`);

export const getNowPlayingMovies = () =>
  tmdbFetch<TmdbPage>(`/movie/now_playing`);

export const getUpcomingMovies = () =>
  tmdbFetch<TmdbPage>(`/movie/upcoming`);

export const getAiringTodayTV = () =>
  tmdbFetch<TmdbPage>(`/tv/airing_today`);

export const getOnTheAirTV = () =>
  tmdbFetch<TmdbPage>(`/tv/on_the_air`);

// ── Discover ───────────────────────────────────────────────────────────────
export const discoverMovies = (params: Record<string, string | number>) => {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  return tmdbFetch<TmdbPage>(`/discover/movie?${qs}`);
};

export const discoverTV = (params: Record<string, string | number>) => {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  return tmdbFetch<TmdbPage>(`/discover/tv?${qs}`);
};

// ── Details ────────────────────────────────────────────────────────────────
export const getFilme = (tmdbId: string | number) =>
  tmdbFetch<TmdbMovie>(`/movie/${tmdbId}`);

export const getSerie = (tmdbId: string | number) =>
  tmdbFetch<TmdbTV>(`/tv/${tmdbId}`);

export const getMovieVideos = (tmdbId: string | number) =>
  tmdbFetch<{ results: TmdbVideo[] }>(`/movie/${tmdbId}/videos`);

export const getTVVideos = (tmdbId: string | number) =>
  tmdbFetch<{ results: TmdbVideo[] }>(`/tv/${tmdbId}/videos`);

export const getMovieCredits = (tmdbId: string | number) =>
  tmdbFetch<{ cast: TmdbCast[]; crew: TmdbCast[] }>(`/movie/${tmdbId}/credits`);

export const getTVCredits = (tmdbId: string | number) =>
  tmdbFetch<{ cast: TmdbCast[]; crew: TmdbCast[] }>(`/tv/${tmdbId}/aggregate_credits`);

export const getMovieRecommendations = (tmdbId: string | number) =>
  tmdbFetch<TmdbPage>(`/movie/${tmdbId}/recommendations`);

export const getTVRecommendations = (tmdbId: string | number) =>
  tmdbFetch<TmdbPage>(`/tv/${tmdbId}/recommendations`);

export const getMovieSimilar = (tmdbId: string | number) =>
  tmdbFetch<TmdbPage>(`/movie/${tmdbId}/similar`);

export const getTVSimilar = (tmdbId: string | number) =>
  tmdbFetch<TmdbPage>(`/tv/${tmdbId}/similar`);

export const getTVSeasonDetails = (tmdbId: string | number, season: number) =>
  tmdbFetch<TmdbSeasonDetails>(`/tv/${tmdbId}/season/${season}`);

export const getCollection = (collectionId: number) =>
  tmdbFetch<TmdbCollection>(`/collection/${collectionId}`);

export const getPerson = (personId: string | number) =>
  tmdbFetch<TmdbPerson>(`/person/${personId}?append_to_response=combined_credits`);

// ── Images / Logos / Backdrops ─────────────────────────────────────────────

export interface TmdbImageEntry {
  file_path: string;
  iso_639_1: string | null;
  width: number;
  height: number;
  vote_average: number;
  vote_count: number;
}

export interface TmdbImages {
  backdrops?: TmdbImageEntry[];
  posters?: TmdbImageEntry[];
  logos?: TmdbImageEntry[];
}

/**
 * Busca imagens do filme com preferência por conteúdo pt-BR.
 * include_image_language=pt,null,en → retorna: pt (banner c/ texto em PT)
 * depois null (banner sem texto, neutro) e en como fallback final.
 * language=pt-BR → metadados em português.
 */
export const getMovieImages = (tmdbId: string | number) =>
  tmdbFetch<TmdbImages>(
    `/movie/${tmdbId}/images?include_image_language=pt,null,en`
  );

export const getTVImages = (tmdbId: string | number) =>
  tmdbFetch<TmdbImages>(
    `/tv/${tmdbId}/images?include_image_language=pt,null,en`
  );

/**
 * Escolhe o backdrop LIMPO, sem titulo desenhado na arte.
 *
 * No TMDB, `iso_639_1` de um backdrop diz qual texto esta impresso na imagem:
 * `null` e arte limpa, "pt"/"en" tem o nome queimado naquele idioma.
 *
 * O card desenha o nome por cima — logo oficial quando existe, texto quando
 * nao existe. Entao a arte precisa vir sem nome: backdrop com titulo queimado
 * mais o logo por cima coloca o nome duas vezes na mesma imagem, que foi
 * exatamente o motivo de o logo ter sido removido da primeira vez.
 *
 * Medido em amostra de 320 titulos: 98% dos filmes e 94% das series tem ao
 * menos um backdrop limpo, entao os degraus seguintes quase nunca entram.
 * Quando entram, o card ainda assim se protege — ver LandscapeCard.
 *
 * Empate resolvido por vote_average e depois pela largura.
 */
export function pickBackdrop(images: TmdbImages | null | undefined): string | null {
  const backdrops = images?.backdrops;
  if (!backdrops?.length) return null;

  const byLang = (lang: string | null) =>
    [...backdrops]
      .filter((b) => (b.iso_639_1 ?? null) === lang)
      .sort((a, b) => b.vote_average - a.vote_average || (b.width ?? 0) - (a.width ?? 0))[0];

  return (
    byLang(null)?.file_path ??
    byLang("pt")?.file_path ??
    byLang("en")?.file_path ??
    backdrops[0].file_path
  );
}

/**
 * O hero quer a mesma arte limpa, porque tambem desenha o titulo por cima.
 * Mantido como nome proprio porque as paginas de detalhe ja o importam assim.
 */
export const pickHeroBackdrop = pickBackdrop;

/**
 * Ordem de preferencia do logo, exatamente como pedido no hero:
 * pt-BR > pt > en > sem idioma > qualquer coisa que exista.
 * A API de imagens do TMDB so expoe iso_639_1 (sem regiao), entao na pratica
 * "pt-BR" e "pt" caem no mesmo balde — a entrada fica aqui para o dia em que
 * o TMDB passar a diferenciar, sem quebrar a cadeia de fallback.
 */
const LOGO_LANG_PRIORITY: (string | null)[] = ["pt-BR", "pt", "en", null];

/** PNG antes de SVG: o SVG do TMDB as vezes vem sem viewBox e estoura o layout. */
const isRaster = (entry: TmdbImageEntry) => (entry.file_path?.toLowerCase().endsWith(".svg") ? 0 : 1);

function bestLogo(list: TmdbImageEntry[]): TmdbImageEntry | undefined {
  return [...list].sort(
    (a, b) =>
      isRaster(b) - isRaster(a) ||
      b.vote_average - a.vote_average ||
      (b.width ?? 0) - (a.width ?? 0)
  )[0];
}

export function pickLogo(images: TmdbImages | null | undefined): string | null {
  const logos = images?.logos;
  if (!logos?.length) return null;

  for (const lang of LOGO_LANG_PRIORITY) {
    const group = logos.filter((l) => (l.iso_639_1 ?? null) === lang);
    const chosen = bestLogo(group);
    if (chosen) return chosen.file_path;
  }
  return bestLogo(logos)?.file_path ?? null;
}

export function logoUrl(path: string | null | undefined, size = "w300"): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${IMG}/${size}${path}`;
}

// -- Classificacao indicativa (ClassInd / BR) -------------------------------

interface TmdbReleaseDates {
  results?: { iso_3166_1: string; release_dates?: { certification?: string; type?: number }[] }[];
}

interface TmdbContentRatings {
  results?: { iso_3166_1: string; rating?: string }[];
}

const normalizeCert = (value: string | null | undefined) => {
  const cert = value?.trim().toUpperCase();
  if (!cert) return null;
  // "L" / "LIVRE" viram sempre "L"; "10 ANOS" vira "10".
  if (cert.startsWith("L")) return "L";
  const age = cert.match(/\d{1,2}/)?.[0];
  return age ?? cert;
};

/** Classificacao indicativa brasileira do filme (ex.: "L", "12", "16"). */
export async function getMovieCertification(tmdbId: string | number): Promise<string | null> {
  const data = await tmdbFetch<TmdbReleaseDates>(`/movie/${tmdbId}/release_dates`);
  const br = data?.results?.find((r) => r.iso_3166_1 === "BR");
  const cert = br?.release_dates?.map((r) => r.certification).find((c) => c && c.trim());
  return normalizeCert(cert);
}

/** Classificacao indicativa brasileira da serie/anime/desenho. */
export async function getTVCertification(tmdbId: string | number): Promise<string | null> {
  const data = await tmdbFetch<TmdbContentRatings>(`/tv/${tmdbId}/content_ratings`);
  const br = data?.results?.find((r) => r.iso_3166_1 === "BR");
  return normalizeCert(br?.rating);
}

// ── Search ─────────────────────────────────────────────────────────────────
export const searchFilme = (query: string) =>
  tmdbFetch<TmdbPage>(`/search/movie?query=${encodeURIComponent(query)}`);

export const searchSerie = (query: string) =>
  tmdbFetch<TmdbPage>(`/search/tv?query=${encodeURIComponent(query)}`);

// ── Helpers ────────────────────────────────────────────────────────────────
export function pickTrailer(videos: TmdbVideo[] | undefined): TmdbVideo | null {
  if (!videos?.length) return null;
  return (
    videos.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ??
    videos.find((v) => v.site === "YouTube" && v.type === "Trailer") ??
    videos.find((v) => v.site === "YouTube") ??
    null
  );
}

// ── Types ──────────────────────────────────────────────────────────────────
export interface TmdbItem {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  media_type?: string;
  original_language?: string;
  genre_ids?: number[];
  popularity?: number;
}

export interface TmdbPage {
  results: TmdbItem[];
  total_pages: number;
  total_results: number;
}

export interface TmdbMovie extends TmdbItem {
  runtime?: number;
  genres?: { id: number; name: string }[];
  tagline?: string;
}

export interface TmdbTV extends TmdbItem {
  number_of_seasons?: number;
  number_of_episodes?: number;
  genres?: { id: number; name: string }[];
  created_by?: TmdbPersonPreview[];
}

export interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  official: boolean;
  name: string;
}

export interface TmdbCast {
  id: number;
  name: string;
  character?: string;
  roles?: { character: string }[];
  job?: string;
  department?: string;
  jobs?: { job: string; episode_count?: number }[];
  profile_path?: string | null;
  order?: number;
}

export interface TmdbPersonPreview {
  id: number;
  name: string;
  profile_path?: string | null;
}

export interface TmdbPersonCredit extends TmdbItem {
  character?: string;
  job?: string;
  department?: string;
  credit_id?: string;
  episode_count?: number;
}

export interface TmdbPerson {
  id: number;
  name: string;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  profile_path?: string | null;
  known_for_department?: string;
  also_known_as?: string[];
  combined_credits?: {
    cast?: TmdbPersonCredit[];
    crew?: TmdbPersonCredit[];
  };
}

export interface TmdbEpisodeDetails {
  episode_number: number;
  season_number: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  still_path?: string | null;
  runtime?: number | null;
  vote_average: number;
  vote_count: number;
}

export interface TmdbSeasonDetails {
  season_number: number;
  episodes: TmdbEpisodeDetails[];
}

export interface TmdbCollection {
  id: number;
  name: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  parts: TmdbItem[];
}
