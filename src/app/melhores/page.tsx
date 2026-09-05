import { prisma } from "@/lib/prisma";
import { imgUrl } from "@/lib/tmdb";
import { MelhoresClient, type ChartItem } from "./MelhoresClient";
import { editorialAliases, EMMY_SERIES, matchEditorialEntries, OSCAR_FILMS } from "@/lib/editorialCatalog";
import { dedupeCatalogo } from "@/lib/canonical";

// Lido do banco (top250/popularRank), não mais buscado ao vivo do TMDB — os
// Os scripts locais que mantêm esses campos são os únicos que escrevem aqui.
export const dynamic = "force-dynamic";

const selFilme = {
  id: true, tmdbId: true, titulo: true, poster: true, background: true, logo: true, sinopse: true, duracao: true, ano: true, nota: true,
  urlDub: true, urlLeg: true, top250: true, popularRank: true,
  generos: { select: { genero: { select: { nome: true } } } },
} as const;

const selSerie = {
  id: true, tmdbId: true, titulo: true, poster: true, background: true, logo: true, sinopse: true, temporadas: true, ano: true, nota: true,
  top250: true, popularRank: true,
  generos: { select: { genero: { select: { nome: true } } } },
  _count: { select: { episodios: true } },
} as const;

const awardSelect = {
  id: true, tmdbId: true, titulo: true, tituloOriginal: true, poster: true, background: true, logo: true, ano: true,
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

function serieToChart(s: any, rankField: "top250" | "popularRank"): ChartItem {
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
    rank: s[rankField],
    disponivel: s._count.episodios > 0,
  };
}

export default async function MelhoresPage() {
  const [topFilmes, topSeries, popFilmes, popSeries, oscarRaw, emmyRaw] = await Promise.all([
    prisma.filme.findMany({ where: { top250: { not: null } }, orderBy: { top250: "asc" }, select: selFilme }),
    prisma.serie.findMany({ where: { top250: { not: null } }, orderBy: { top250: "asc" }, select: selSerie }),
    prisma.filme.findMany({ where: { popularRank: { not: null } }, orderBy: { popularRank: "asc" }, select: selFilme }),
    prisma.serie.findMany({ where: { popularRank: { not: null } }, orderBy: { popularRank: "asc" }, select: selSerie }),
    prisma.filme.findMany({
      where: {
        AND: [
          { OR: [
            { titulo: { in: editorialAliases(OSCAR_FILMS), mode: "insensitive" } },
            { tituloOriginal: { in: editorialAliases(OSCAR_FILMS), mode: "insensitive" } },
          ] },
          { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
        ],
      },
      select: awardSelect,
    }),
    prisma.serie.findMany({
      where: {
        tipo: "serie",
        AND: [
          { OR: [
            { titulo: { in: editorialAliases(EMMY_SERIES), mode: "insensitive" } },
            { tituloOriginal: { in: editorialAliases(EMMY_SERIES), mode: "insensitive" } },
          ] },
          { episodios: { some: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] } } },
        ],
      },
      select: awardSelect,
    }),
  ]);

  const oscarItems = matchEditorialEntries(OSCAR_FILMS, dedupeCatalogo(oscarRaw, "filme")).map(({ item, entry }) => ({
    id: item.id, tipo: "filme" as const, titulo: item.titulo,
    poster: item.poster ?? null, background: item.background ?? null, logo: item.logo ?? null,
    ano: item.ano ?? null, count: entry.value ?? 0,
  }));
  const emmyItems = matchEditorialEntries(EMMY_SERIES, dedupeCatalogo(emmyRaw, "serie")).map(({ item, entry }) => ({
    id: item.id, tipo: "serie" as const, titulo: item.titulo,
    poster: item.poster ?? null, background: item.background ?? null, logo: item.logo ?? null,
    ano: item.ano ?? null, count: entry.value ?? 0,
  }));

  return (
    <MelhoresClient
      topFilmes={dedupeCatalogo(topFilmes, "filme").map((f) => filmeToChart(f, "top250"))}
      topSeries={dedupeCatalogo(topSeries, "serie").map((s) => serieToChart(s, "top250"))}
      popFilmes={dedupeCatalogo(popFilmes, "filme").map((f) => filmeToChart(f, "popularRank"))}
      popSeries={dedupeCatalogo(popSeries, "serie").map((s) => serieToChart(s, "popularRank"))}
      oscarItems={oscarItems}
      emmyItems={emmyItems}
    />
  );
}
