const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";
export const IMG = "https://image.tmdb.org/t/p";

async function tmdbFetch(url: string) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

export function imgUrl(path: string | null | undefined, size = "w500") {
  if (!path) return "/placeholder.jpg";
  return `${IMG}/${size}${path}`;
}

export const searchFilme = (query: string) =>
  tmdbFetch(`${BASE}/search/movie?query=${encodeURIComponent(query)}&language=pt-BR&api_key=${TMDB_KEY}`);

export const searchSerie = (query: string) =>
  tmdbFetch(`${BASE}/search/tv?query=${encodeURIComponent(query)}&language=pt-BR&api_key=${TMDB_KEY}`);

export const getFilme = (tmdbId: string) =>
  tmdbFetch(`${BASE}/movie/${tmdbId}?language=pt-BR&api_key=${TMDB_KEY}`);

export const getSerie = (tmdbId: string) =>
  tmdbFetch(`${BASE}/tv/${tmdbId}?language=pt-BR&api_key=${TMDB_KEY}`);

export const getTrending = () =>
  tmdbFetch(`${BASE}/trending/all/week?language=pt-BR&api_key=${TMDB_KEY}`);
