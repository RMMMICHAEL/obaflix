import { filmeDisponivel, serieDisponivel } from "@/lib/catalog-availability";
import { getBrazilSeriesRanking, orderBrazilSeriesRows } from "@/lib/brazil-series-ranking";
import { prisma } from "@/lib/prisma";
import { imgUrl } from "@/lib/tmdb";
import { MelhoresClient, type ChartItem } from "./MelhoresClient";
import { editorialAliases, EMMY_SERIES, matchEditorialEntries, OSCAR_FILMS } from "@/lib/editorialCatalog";

// IMDb Top 250 e filmes mantêm os campos locais. Séries populares usam Brasil 7d.
export const dynamic = "force-dynamic";

const selFilme = {
  id: true, titulo: true, poster: true, background: true, logo: true, sinopse: true, duracao: true, ano: true, nota: true,
  urlDub: true, urlLeg: true, top250: true, popularRank: true,
  generos: { select: { genero: { select: { nome: true } } } },
} as const;

const selSerie = {
  id: true, titulo: true, poster: true, background: true, logo: true, sinopse: true, temporadas: true, ano: true, nota: true,
  top250: true,
  generos: { select: { genero: { select: { nome: true } } } },
  _count: { select: { episodios: true } },
} as const;

const awardSelect = {
  id: true, titulo: true, tituloOriginal: true, poster: true, background: true, logo: true, ano: true,
} as const;

function uniqueGenres(rows: Array<{ genero: { nome: string } }>) {
  const unique = new Map<string, string>();
  for (const row of rows) {
    const key = row.genero.nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
    if (!unique.has(key)) unique.set(key, row.genero.nome);
  }
  return [...unique.values()];
}

function filmeToChart(f: any, rankField: "top250" | "popularRank"): ChartItem {
  return {
    id: f.id,
    titulo: f.titulo,
    ano: f.ano ? String(f.ano) : "",
    nota: Math.round((f.nota ?? 0) * 10) / 10,
    poster: f.poster ? imgUrl(f.poster, "w185") : null,
    background: f.background ? imgUrl(f.background, "original") : null,
    logo: f.logo ? imgUrl(f.logo, "w500") : null,
    sinopse: f.sinopse,
    detalhe: f.duracao ? `${f.duracao} min` : null,
    generos: uniqueGenres(f.generos),
    rank: f[rankField],
    disponivel: !!(f.urlDub || f.urlLeg),
  };
}

function serieToChart(s: any, rankField: "top250" | number): ChartItem {
  return {
    id: s.id,
    titulo: s.titulo,
    ano: s.ano ? String(s.ano) : "",
    nota: Math.round((s.nota ?? 0) * 10) / 10,
    poster: s.poster ? imgUrl(s.poster, "w185") : null,
    background: s.background ? imgUrl(s.background, "original") : null,
    logo: s.logo ? imgUrl(s.logo, "w500") : null,
    sinopse: s.sinopse,
    detalhe: s.temporadas ? `${s.temporadas} temporada${s.temporadas === 1 ? "" : "s"}` : null,
    generos: uniqueGenres(s.generos),
    rank: typeof rankField === "number" ? rankField : s[rankField],
    disponivel: s._count.episodios > 0,
  };
}

export default async function MelhoresPage() {
  const brWeekIds = await getBrazilSeriesRanking("week", 250);
  const [topFilmes, topSeries, popFilmes, popSeries, oscarRaw, emmyRaw] = await Promise.all([
    prisma.filme.findMany({ where: filmeDisponivel({ top250: { not: null } }), orderBy: { top250: "asc" }, select: selFilme }),
    prisma.serie.findMany({ where: serieDisponivel({ top250: { not: null } }), orderBy: { top250: "asc" }, select: selSerie }),
    prisma.filme.findMany({ where: filmeDisponivel({ popularRank: { not: null } }), orderBy: { popularRank: "asc" }, select: selFilme }),
    prisma.serie.findMany({ where: serieDisponivel({ id: { in: brWeekIds } }), select: selSerie }),
    prisma.filme.findMany({
      where: filmeDisponivel({
        AND: [
          { OR: [
            { titulo: { in: editorialAliases(OSCAR_FILMS), mode: "insensitive" } },
            { tituloOriginal: { in: editorialAliases(OSCAR_FILMS), mode: "insensitive" } },
          ] },
        ],
      }),
      select: awardSelect,
    }),
    prisma.serie.findMany({
      where: serieDisponivel({
        tipo: "serie",
        AND: [
          { OR: [
            { titulo: { in: editorialAliases(EMMY_SERIES), mode: "insensitive" } },
            { tituloOriginal: { in: editorialAliases(EMMY_SERIES), mode: "insensitive" } },
          ] },
        ],
      }),
      select: awardSelect,
    }),
  ]);

  const oscarItems = matchEditorialEntries(OSCAR_FILMS, oscarRaw).map(({ item, entry }) => ({
    id: item.id, tipo: "filme" as const, titulo: item.titulo,
    poster: item.poster ?? null, background: item.background ?? null, logo: item.logo ?? null,
    ano: item.ano ?? null, count: entry.value ?? 0,
  }));
  const emmyItems = matchEditorialEntries(EMMY_SERIES, emmyRaw).map(({ item, entry }) => ({
    id: item.id, tipo: "serie" as const, titulo: item.titulo,
    poster: item.poster ?? null, background: item.background ?? null, logo: item.logo ?? null,
    ano: item.ano ?? null, count: entry.value ?? 0,
  }));

  return (
    <MelhoresClient
      topFilmes={topFilmes.map((f) => filmeToChart(f, "top250"))}
      topSeries={topSeries.map((s) => serieToChart(s, "top250"))}
      popFilmes={popFilmes.map((f) => filmeToChart(f, "popularRank"))}
      popSeries={orderBrazilSeriesRows(brWeekIds, popSeries).map((s, index) => serieToChart(s, index + 1))}
      oscarItems={oscarItems}
      emmyItems={emmyItems}
    />
  );
}
