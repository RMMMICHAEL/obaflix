import { prisma } from "@/lib/prisma";

type CatalogDb = typeof prisma;
type GenreInput = { id: number; nome: string };
type JsonObject = Record<string, unknown>;

/**
 * Semântica de campo:
 *   - ausente → não toca no valor atual (origem incompleta não apaga dado bom);
 *   - `null`  → limpa explicitamente — exceto para máquina (`nullIsAbsent`),
 *               em que a origem manda null quando simplesmente não tem o dado;
 *   - `""`    → ausente para integrações; em texto, limpa (`null`) só quando o
 *               chamador é o editor humano (`emptyStringClears`), que manda ""
 *               ao apagar. Em número, "" é sempre ausente.
 *   - `protectSpecificTipo`: `tipo: "serie"` (o genérico) não rebaixa uma
 *               série já classificada como anime/desenho.
 */
export type CatalogWriteOptions = { emptyStringClears?: boolean; nullIsAbsent?: boolean; protectSpecificTipo?: boolean };

/** Escrita máquina→máquina (integrações e token legado de catálogo). */
export const CATALOG_WRITE_MAQUINA: CatalogWriteOptions = Object.freeze({ nullIsAbsent: true, protectSpecificTipo: true });

/** Tipos específicos que um `tipo: "serie"` genérico não pode sobrescrever. */
const TIPOS_ESPECIFICOS = new Set(["anime", "desenho"]);

const has = (value: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const INT_FIELDS = new Set(["ano", "voteCount", "duracao", "top250", "popularRank", "popularRankPrev", "sagaId", "temporadas"]);

function stringField(options: CatalogWriteOptions) {
  return (value: unknown) => {
    if (value === null) return options.nullIsAbsent ? undefined : null;
    if (typeof value === "number") return String(value);
    if (typeof value !== "string") return undefined;
    if (value.trim() === "") return options.emptyStringClears ? null : undefined;
    return value;
  };
}

/** Número vazio nunca apaga: o formulário manda "" em todo campo não preenchido. */
function numberField(integer: boolean, options: CatalogWriteOptions) {
  return (value: unknown) => {
    if (value === null) return options.nullIsAbsent ? undefined : null;
    if (typeof value === "string" && value.trim() === "") return undefined;
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    return integer ? Math.trunc(n) : n;
  };
}

function requiredText(value: unknown, field: string): string {
  const result = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!result) throw new Error(`${field} obrigatório`);
  return result;
}

/** Lista vazia conta como ausente: nunca apagar gêneros existentes por falta de dado. */
function genres(value: unknown): GenreInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = Number((item as JsonObject).id);
    const nome = String((item as JsonObject).nome ?? (item as JsonObject).name ?? "").trim();
    return Number.isInteger(id) && nome ? [{ id, nome }] : [];
  });
  return list.length > 0 ? list : undefined;
}

function setIfPresent(target: JsonObject, input: JsonObject, key: string, transform: (v: unknown) => unknown) {
  if (!has(input, key)) return;
  const value = transform(input[key]);
  if (value !== undefined) target[key] = value;
}

export async function upsertCatalogMovie(input: JsonObject, db: CatalogDb = prisma, options: CatalogWriteOptions = {}) {
  const id = requiredText(input.id, "id");
  const titulo = requiredText(input.titulo, "titulo");
  const before = await db.filme.findUnique({ where: { id }, select: { id: true } });
  const update: JsonObject = { titulo };
  for (const key of ["tmdbId", "imdbId", "tituloOriginal", "poster", "background", "logo", "sinopse", "urlDub", "urlLeg", "originalLanguage"]) {
    setIfPresent(update, input, key, stringField(options));
  }
  for (const key of ["ano", "nota", "voteCount", "popularidade", "scoreDestaque", "duracao", "top250", "popularRank", "popularRankPrev", "sagaId"]) {
    setIfPresent(update, input, key, numberField(INT_FIELDS.has(key), options));
  }
  const create = { id, ...update } as any;
  const movie = await db.filme.upsert({ where: { id }, update: update as any, create });
  const incomingGenres = genres(input.generos);
  if (incomingGenres !== undefined) {
    await db.$transaction(async (tx) => {
      await tx.filmeGenero.deleteMany({ where: { filmeId: id } });
      for (const genre of incomingGenres) {
        await tx.genero.upsert({ where: { id: genre.id }, update: { nome: genre.nome }, create: genre });
        await tx.filmeGenero.create({ data: { filmeId: id, generoId: genre.id } });
      }
    });
  }
  return { id: movie.id, created: !before };
}

export async function upsertCatalogSeries(input: JsonObject, db: CatalogDb = prisma, options: CatalogWriteOptions = {}) {
  const id = requiredText(input.id, "id");
  const titulo = requiredText(input.titulo, "titulo");
  const before = await db.serie.findUnique({ where: { id }, select: { id: true, tipo: true } });
  const update: JsonObject = { titulo };
  for (const key of ["tmdbId", "imdbId", "tituloOriginal", "poster", "background", "logo", "sinopse", "originalLanguage"]) {
    setIfPresent(update, input, key, stringField(options));
  }
  for (const key of ["ano", "nota", "voteCount", "popularidade", "scoreDestaque", "temporadas", "top250", "popularRank", "popularRankPrev"]) {
    setIfPresent(update, input, key, numberField(INT_FIELDS.has(key), options));
  }
  // `tipo` é obrigatório no banco: só muda com valor real; na criação, "serie".
  if (typeof input.tipo === "string" && input.tipo.trim()) update.tipo = input.tipo.trim();
  if (options.protectSpecificTipo && update.tipo === "serie" && before?.tipo && TIPOS_ESPECIFICOS.has(before.tipo)) {
    delete update.tipo;
  }
  const create = { id, tipo: "serie", ...update };
  const series = await db.serie.upsert({ where: { id }, update: update as any, create: create as any });
  const incomingGenres = genres(input.generos);
  if (incomingGenres !== undefined) {
    await db.$transaction(async (tx) => {
      await tx.serieGenero.deleteMany({ where: { serieId: id } });
      for (const genre of incomingGenres) {
        await tx.genero.upsert({ where: { id: genre.id }, update: { nome: genre.nome }, create: genre });
        await tx.serieGenero.create({ data: { serieId: id, generoId: genre.id } });
      }
    });
  }
  return { id: series.id, created: !before };
}

export async function upsertCatalogEpisode(input: JsonObject, db: CatalogDb = prisma, options: CatalogWriteOptions = {}) {
  const serieId = requiredText(input.serieId, "serieId");
  // Sem temporada informada vale 1 — o mesmo padrão que o bulk legado sempre usou.
  const temporada = Number(input.temporada ?? input.temp ?? 1);
  const numeroEp = Number(input.numeroEp ?? input.ep);
  if (!Number.isInteger(temporada) || temporada < 1 || !Number.isInteger(numeroEp) || numeroEp < 1) {
    throw new Error("temporada e numeroEp inválidos");
  }
  const key = { serieId, temporada, numeroEp };
  const normalized: JsonObject = { ...input };
  // Aliases dos produtores legados (MegaFlix: urlBR/urlENG/nome). Vale o
  // primeiro com conteúdo, como no `a || b` do bulk antigo.
  const filled = (value: unknown) => typeof value === "string" && value.trim() !== "";
  const alias = (field: string, ...alternatives: string[]) => {
    if (filled(normalized[field])) return;
    const found = alternatives.map((key) => input[key]).find(filled);
    if (found !== undefined) normalized[field] = found;
  };
  alias("urlDub", "urlBR", "url_dub");
  alias("urlLeg", "urlENG", "url_leg");
  alias("titulo", "nome");
  const update: JsonObject = {};
  for (const field of ["titulo", "thumbnail", "urlDub", "urlLeg"]) setIfPresent(update, normalized, field, stringField(options));
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : `${serieId}-t${temporada}e${numeroEp}`;
  return writeEpisodeAtCoordinate(db, key, id, update);
}

/**
 * Identidade do episódio = (serieId, temporada, numeroEp), nunca o ID externo.
 *
 * Não usa `upsert` na chave composta de propósito: o índice único ainda pode
 * não existir no banco (migration 20260930120000), e aí o `ON CONFLICT` do
 * upsert nativo do Prisma falharia. `findFirst` + `update`/`create` funciona
 * com e sem índice; com duplicatas antigas, atualiza sempre a mesma linha (a
 * mais antiga) em vez de criar uma terceira. Com o índice, uma corrida no
 * `create` vira P2002 e é refeita como update.
 */
async function writeEpisodeAtCoordinate(
  db: CatalogDb,
  key: { serieId: string; temporada: number; numeroEp: number },
  id: string,
  update: JsonObject,
): Promise<{ id: string; created: boolean }> {
  const find = () => db.episodio.findFirst({ where: key, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
  const existing = await find();
  if (existing) {
    if (Object.keys(update).length > 0) await db.episodio.update({ where: { id: existing.id }, data: update as any });
    return { id: existing.id, created: false };
  }
  try {
    const created = await db.episodio.create({ data: { id, ...key, ...update } as any, select: { id: true } });
    return { id: created.id, created: true };
  } catch (error) {
    if ((error as { code?: string })?.code !== "P2002") throw error;
    const raced = await find();
    if (!raced) throw error; // conflito de PK com outra coordenada: não é nosso para resolver
    if (Object.keys(update).length > 0) await db.episodio.update({ where: { id: raced.id }, data: update as any });
    return { id: raced.id, created: false };
  }
}

export async function upsertCatalogEpisodesBulk(serieId: string, episodios: unknown[], db: CatalogDb = prisma, options: CatalogWriteOptions = {}) {
  let added = 0;
  let updated = 0;
  const errors: Array<{ index: number; error: string }> = [];
  for (let index = 0; index < episodios.length; index++) {
    try {
      const episode = episodios[index];
      if (!episode || typeof episode !== "object") throw new Error("episódio inválido");
      const result = await upsertCatalogEpisode({ ...(episode as JsonObject), serieId }, db, options);
      if (result.created) added++;
      else updated++;
    } catch (error) {
      errors.push({ index, error: error instanceof Error ? error.message : "erro desconhecido" });
    }
  }
  return { added, updated, errors };
}
