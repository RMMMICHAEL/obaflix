import { slugifySeo } from "@/lib/catalog-url";

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

/**
 * Consolida g\u00eaneros semanticamente duplicados (Fase 4). A chave de agrupamento \u00e9
 * o MESMO slug que vai para a URL (`slugifySeo(nome)`), ent\u00e3o "A\u00e7\u00e3o"/"Acao" (ou
 * os pares de ids duplicados vindos do provedor, ex. terror 5 e 27) caem num
 * grupo s\u00f3 e passam a ter uma \u00fanica URL can\u00f4nica.
 *
 * O representante \u00e9 determin\u00edstico: o MENOR id do grupo \u00e9 o can\u00f4nico, e o `nome`
 * acompanha esse id (n\u00e3o o primeiro visto), para a sa\u00edda n\u00e3o depender da ordem
 * recebida do banco. `ids` traz todos os membros, em ordem crescente \u2014 \u00e9 com ele
 * que a p\u00e1gina consulta o cat\u00e1logo do grupo inteiro (`generoId in ids`).
 */
export function groupGenres(genres: GenreRecord[]): GenreOption[] {
  const grouped = new Map<string, GenreOption>();

  for (const genre of genres) {
    const key = slugifySeo(genre.nome);
    const current = grouped.get(key);
    if (current) {
      if (!current.ids.includes(genre.id)) current.ids.push(genre.id);
      // Menor id \u00e9 o can\u00f4nico; o nome segue o representante.
      if (genre.id < current.id) {
        current.id = genre.id;
        current.nome = genre.nome;
      }
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
