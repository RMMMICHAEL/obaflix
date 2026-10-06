/**
 * URLs canônicas de catálogo: `<slug>--<id>`.
 *
 * O ID continua sendo a identidade real (a consulta é sempre por PK). O slug é
 * só apresentação/SEO, derivado do título em tempo de render — por isso não há
 * coluna nova no banco, migration nem backfill, e um título novo já nasce com a
 * URL certa. O separador é `--` (dois hifens): `slugifySeo` nunca produz hifens
 * repetidos, então o último `--` separa slug de id sem ambiguidade, mesmo em
 * títulos como "9-1-1".
 *
 *   /filme/nando--xyz456
 *   /serie/o-mentalista--abc123
 *   /genero/crime--80
 *
 * Anime e desenho moram em `/serie/<id>` (não há rota `/anime` nem `/desenho`).
 */

export const SEO_SEP = "--";

/**
 * "O Mentalista" → "o-mentalista"; "Ficção Científica" → "ficcao-cientifica".
 *
 * lowercase, sem acentos, pontuação/espaço viram "-", hifens repetidos colapsam,
 * e as bordas ficam sem hifen. Título vazio (ou só símbolos) cai no fallback
 * para a URL nunca ficar sem segmento de slug.
 */
export function slugifySeo(input: string | null | undefined): string {
  const slug = (input ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "titulo";
}

/** Segmento `<slug>--<id>` para um conteúdo de catálogo. */
export function catalogSlugId(titulo: string | null | undefined, id: string): string {
  return `${slugifySeo(titulo)}${SEO_SEP}${id}`;
}

/** Rota canônica de um filme/série. anime/desenho → `/serie/<...>`. */
export function catalogPath(
  tipo: "filme" | "serie" | "anime" | "desenho" | string,
  id: string,
  titulo: string | null | undefined,
): string {
  const base = tipo === "filme" ? "filme" : "serie";
  return `/${base}/${catalogSlugId(titulo, id)}`;
}

/** Rota canônica de um gênero. O id do gênero é numérico (TMDB). */
export function genrePath(id: number | string, nome: string | null | undefined): string {
  return `/genero/${slugifySeo(nome)}${SEO_SEP}${id}`;
}

/**
 * Extrai o id real de um parâmetro `<slug>--<id>`.
 *
 * Sem separador, o parâmetro inteiro é o id — é assim que as URLs legadas
 * (`/filme/<id>`) continuam resolvendo antes do redirect canônico.
 */
export function parseSeoParam(param: string): string {
  const i = param.lastIndexOf(SEO_SEP);
  return i >= 0 ? param.slice(i + SEO_SEP.length) : param;
}
