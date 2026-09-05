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

/**
 * Equivalencias de genero entre os catalogos de filme e de TV do TMDB.
 *
 * O TMDB nao usa a mesma tabela para os dois. Filme tem `28 Acao` e
 * `12 Aventura` separados; TV tem um genero so, `10759 Acao & Aventura`. O
 * mesmo vale para ficcao/fantasia e para guerra. Como o catalogo importa de
 * fontes que passam ora um conjunto ora o outro, a mesma serie acaba marcada
 * com o id de filme numa linha e com o id de TV noutra.
 *
 * `groupGenres` funde por NOME, e "Aventura" nao e igual a "Acao & Aventura" —
 * entao os dois grupos nunca se encontravam e o filtro enxergava so metade do
 * acervo. Era esse o motivo de "series em Aventura" devolver quase nada.
 *
 * A expansao e deliberadamente ASSIMETRICA, nao um agrupamento. Escolher
 * "Aventura" busca `12` e `10759`; escolher "Acao" busca `28` e `10759`. Se os
 * tres virassem um grupo unico, Acao e Aventura passariam a devolver
 * exatamente a mesma lista — e essa distincao e real para filmes.
 *
 * Os pares comentados com ★ sao os que o projeto realmente exibe hoje em
 * prateleiras e filtros; os demais existem no TMDB e entram para que o
 * catalogo nao volte a perder titulo quando uma fonte nova os trouxer.
 */
const EQUIVALENCIAS_FILME_TV: ReadonlyArray<readonly [number, number]> = [
  [28, 10759],    // ★ Ação            ↔ Ação & Aventura
  [12, 10759],    // ★ Aventura        ↔ Ação & Aventura
  [878, 10765],   // ★ Ficção científica ↔ Ficção científica & Fantasia
  [14, 10765],    //   Fantasia        ↔ Ficção científica & Fantasia
  [10752, 10768], //   Guerra          ↔ Guerra & Política
];

const EQUIVALENTES = new Map<number, number[]>();
for (const [filme, tv] of EQUIVALENCIAS_FILME_TV) {
  EQUIVALENTES.set(filme, [...(EQUIVALENTES.get(filme) ?? []), tv]);
  EQUIVALENTES.set(tv, [...(EQUIVALENTES.get(tv) ?? []), filme]);
}

/**
 * Acrescenta os ids equivalentes aos que o usuario escolheu.
 *
 * Aplicada na consulta, nunca no agrupamento: a lista de opcoes continua
 * mostrando os nomes que existem no catalogo, e so a busca fica mais larga.
 */
export function expandGenreIds(ids: readonly number[]): number[] {
  const expandido = new Set<number>();
  for (const id of ids) {
    expandido.add(id);
    for (const equivalente of EQUIVALENTES.get(id) ?? []) expandido.add(equivalente);
  }
  return [...expandido].sort((a, b) => a - b);
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
