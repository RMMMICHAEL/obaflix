const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";
export const IMG = "https://image.tmdb.org/t/p";

async function tmdbFetch<T = any>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${TMDB_KEY}&language=pt-BR`;
    const res = await fetch(url, { next: { revalidate: 3600 }, ...opts });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
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
  profile_path?: string | null;
  order?: number;
}
