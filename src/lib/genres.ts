export interface GenreRecord {
  id: number;
  nome: string;
}

export interface GenreOption extends GenreRecord {
  ids: number[];
}

export function normalizeGenreName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function groupGenres(genres: GenreRecord[]): GenreOption[] {
  const grouped = new Map<string, GenreOption>();

  for (const genre of genres) {
    const key = normalizeGenreName(genre.nome);
    const current = grouped.get(key);
    if (current) {
      if (!current.ids.includes(genre.id)) current.ids.push(genre.id);
      continue;
    }

    grouped.set(key, { id: genre.id, nome: genre.nome, ids: [genre.id] });
  }

  return [...grouped.values()]
    .map((genre) => ({ ...genre, ids: genre.ids.sort((a, b) => a - b) }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

export function parseGenreIds(value?: string | null) {
  if (!value) return [];
  return [...new Set(
    value
      .split(",")
      .map((part) => Number(part))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
}

export function genreOptionValue(genre: Pick<GenreOption, "id" | "ids">) {
  return (genre.ids.length ? genre.ids : [genre.id]).join(",");
}
