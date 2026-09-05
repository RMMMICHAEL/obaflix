export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { searchFilme, searchSerie } from "@/lib/tmdb";
import { checkRateLimit, clientIp } from "@/lib/requestSecurity";
import { publicMedia } from "@/lib/publicMedia";
import { mesclarResultadosBusca } from "@/lib/busca";

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
  tmdbId: string | null;
  titulo: string;
  tituloOriginal: string | null;
  poster: string | null;
  background: string | null;
  logo: string | null;
  ano: number | null;
  nota: number | null;
  urlDub: string | null;
  urlLeg: string | null;
}

interface SerieRow {
  id: string;
  tmdbId: string | null;
  /** Contagem usada so para eleger a melhor linha entre duplicatas. */
  episodios: number;
  titulo: string;
  tituloOriginal: string | null;
  poster: string | null;
  background: string | null;
  logo: string | null;
  ano: number | null;
  nota: number | null;
  tipo: string;
}

async function localSearchFilmes(pattern: string, limit: number): Promise<FilmeRow[]> {
  return prisma.$queryRaw<FilmeRow[]>(
    Prisma.sql`
      SELECT id, "tmdbId", titulo, "tituloOriginal", poster, background, logo, ano, nota, "urlDub", "urlLeg"
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
      SELECT s.id, s."tmdbId", s.titulo, s."tituloOriginal", s.poster, s.background, s.logo,
             s.ano, s.nota, s.tipo,
             (SELECT COUNT(*)::int FROM "Episodio" e WHERE e."serieId" = s.id) AS episodios
      FROM "Serie" s
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
  const rate = await checkRateLimit(`search:${clientIp(req)}`, 60, 60);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Limite de buscas atingido. Tente novamente em instantes." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const tipo = req.nextUrl.searchParams.get("tipo"); // "filme" | "serie" | "anime" | null

  if (!q.trim()) return NextResponse.json({ filmes: [], series: [] });
  if (q.length > 120) return NextResponse.json({ error: "Busca muito longa" }, { status: 400 });

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

  const [filmesByTmdb, seriesByTmdb] = await Promise.all([
    tmdbFilmeIds.length && !onlySeries
      ? prisma
          .$queryRaw<FilmeRow[]>(
            Prisma.sql`
              SELECT id, "tmdbId", titulo, "tituloOriginal", poster, background, logo, ano, nota, "urlDub", "urlLeg"
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
              SELECT s.id, s."tmdbId", s.titulo, s."tituloOriginal", s.poster, s.background, s.logo,
                     s.ano, s.nota, s.tipo,
                     (SELECT COUNT(*)::int FROM "Episodio" e WHERE e."serieId" = s.id) AS episodios
              FROM "Serie" s
              WHERE s."tmdbId" = ANY(${tmdbSerieIds})
              ${tipo ? Prisma.sql`AND tipo = ${tipo}` : Prisma.sql``}
              LIMIT 15
            `
          )
          .catch(() => [] as SerieRow[])
      : ([] as SerieRow[]),
  ]);

  // ── 3. Merge: resultados locais primeiro, TMDB extras depois ──────────────
  //
  // Comparar `id` nao bastava: as duplicatas do catalogo tem ids distintos de
  // proposito, e o cruzamento por tmdbId devolvia as tres linhas de uma vez.
  // A regra vive em @/lib/busca, testada fora da rota.
  const filmes = mesclarResultadosBusca(filmeLocal as FilmeRow[], filmesByTmdb as FilmeRow[], 30);
  const series = mesclarResultadosBusca(serieLocal as SerieRow[], seriesByTmdb as SerieRow[], 30);

  // `episodios` e `tmdbId` sao criterio de eleicao, nao conteudo de vitrine:
  // saem antes da resposta para nao virar superficie exposta a mais.
  const seriesPublicas = series.map(({ tmdbId, episodios, ...serie }) => serie);

  return NextResponse.json({
    filmes: filmes.map(({ tmdbId, ...filme }) => publicMedia(filme)),
    series: seriesPublicas,
  });
}
