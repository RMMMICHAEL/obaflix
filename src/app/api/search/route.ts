export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { searchFilme, searchSerie } from "@/lib/tmdb";

// Remove acentos, hífens e chars especiais — mantém só alfanumérico lowercase
function normalizeQuery(s: string): string {
  return (
    s
      .normalize("NFD")
      // U+0300–U+036F: bloco de diacríticos combinantes (á→a, ã→a, ç→c…)
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
  ); // strip hífens, espaços, etc.
}

// Fragmento SQL que normaliza uma coluna da mesma forma:
// unaccent() cuida dos acentos, regexp_replace remove o restante
function colNorm(col: string) {
  return `regexp_replace(lower(unaccent(coalesce(${col}, ''))), '[^a-z0-9]', '', 'g')`;
}

interface FilmeRow {
  id: string;
  titulo: string;
  tituloOriginal: string | null;
  poster: string | null;
  ano: number | null;
  nota: number | null;
  urlDub: string | null;
  urlLeg: string | null;
}

interface SerieRow {
  id: string;
  titulo: string;
  tituloOriginal: string | null;
  poster: string | null;
  ano: number | null;
  nota: number | null;
  tipo: string;
}

async function localSearchFilmes(pattern: string, limit: number): Promise<FilmeRow[]> {
  return prisma.$queryRaw<FilmeRow[]>(
    Prisma.sql`
      SELECT id, titulo, "tituloOriginal", poster, ano, nota, "urlDub", "urlLeg"
      FROM "Filme"
      WHERE ${Prisma.raw(colNorm("titulo"))} LIKE ${pattern}
         OR ${Prisma.raw(colNorm('"tituloOriginal"'))} LIKE ${pattern}
      ORDER BY nota DESC NULLS LAST
      LIMIT ${limit}
    `
  );
}

async function localSearchSeries(
  pattern: string,
  tipoFilter: string | null,
  limit: number
): Promise<SerieRow[]> {
  const tipoSql = tipoFilter ? Prisma.sql`AND tipo = ${tipoFilter}` : Prisma.sql``;
  return prisma.$queryRaw<SerieRow[]>(
    Prisma.sql`
      SELECT id, titulo, "tituloOriginal", poster, ano, nota, tipo
      FROM "Serie"
      WHERE (
        ${Prisma.raw(colNorm("titulo"))} LIKE ${pattern}
        OR ${Prisma.raw(colNorm('"tituloOriginal"'))} LIKE ${pattern}
      )
      ${tipoSql}
      ORDER BY nota DESC NULLS LAST
      LIMIT ${limit}
    `
  );
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const tipo = req.nextUrl.searchParams.get("tipo"); // "filme" | "serie" | "anime" | null

  if (!q.trim()) return NextResponse.json({ filmes: [], series: [] });

  const normalized = normalizeQuery(q);
  if (!normalized) return NextResponse.json({ filmes: [], series: [] });

  const pattern = `%${normalized}%`;
  const onlyFilmes = tipo === "filme";
  const onlySeries = tipo === "serie" || tipo === "anime";

  // ── 1. Busca local (normalizada) + TMDB em paralelo ────────────────────────
  const [filmeLocal, serieLocal, tmdbFilmes, tmdbSeries] = await Promise.all([
    onlySeries ? [] : localSearchFilmes(pattern, 20).catch(() => [] as FilmeRow[]),
    onlyFilmes
      ? []
      : localSearchSeries(pattern, onlySeries ? tipo : null, 20).catch(() => [] as SerieRow[]),
    onlySeries ? null : searchFilme(q),
    onlyFilmes ? null : searchSerie(q),
  ]);

  // ── 2. TMDB IDs → cruzar com nosso banco ──────────────────────────────────
  const tmdbFilmeIds = (tmdbFilmes?.results ?? []).slice(0, 15).map((r) => String(r.id));
  const tmdbSerieIds = (tmdbSeries?.results ?? []).slice(0, 15).map((r) => String(r.id));

  const localFilmeIdSet = new Set((filmeLocal as FilmeRow[]).map((f) => f.id));
  const localSerieIdSet = new Set((serieLocal as SerieRow[]).map((s) => s.id));

  const [filmesByTmdb, seriesByTmdb] = await Promise.all([
    tmdbFilmeIds.length && !onlySeries
      ? prisma
          .$queryRaw<FilmeRow[]>(
            Prisma.sql`
              SELECT id, titulo, "tituloOriginal", poster, ano, nota, "urlDub", "urlLeg"
              FROM "Filme"
              WHERE "tmdbId" = ANY(${tmdbFilmeIds})
              LIMIT 15
            `
          )
          .catch(() => [] as FilmeRow[])
      : ([] as FilmeRow[]),
    tmdbSerieIds.length && !onlyFilmes
      ? prisma
          .$queryRaw<SerieRow[]>(
            Prisma.sql`
              SELECT id, titulo, "tituloOriginal", poster, ano, nota, tipo
              FROM "Serie"
              WHERE "tmdbId" = ANY(${tmdbSerieIds})
              ${tipo ? Prisma.sql`AND tipo = ${tipo}` : Prisma.sql``}
              LIMIT 15
            `
          )
          .catch(() => [] as SerieRow[])
      : ([] as SerieRow[]),
  ]);

  // ── 3. Merge: resultados locais primeiro, TMDB extras depois ──────────────
  const filmes = [
    ...(filmeLocal as FilmeRow[]),
    ...(filmesByTmdb as FilmeRow[]).filter((f) => !localFilmeIdSet.has(f.id)),
  ].slice(0, 30);

  const series = [
    ...(serieLocal as SerieRow[]),
    ...(seriesByTmdb as SerieRow[]).filter((s) => !localSerieIdSet.has(s.id)),
  ].slice(0, 30);

  return NextResponse.json({ filmes, series });
}
