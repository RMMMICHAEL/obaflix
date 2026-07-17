import { prisma } from "@/lib/prisma";
import { imgUrl } from "@/lib/tmdb";
import { MelhoresClient, type ChartItem } from "./MelhoresClient";

// Lido do banco (top250/popularRank), não mais buscado ao vivo do TMDB — os
// crons/scripts que mantêm esses campos são os únicos que escrevem aqui.
// revalidatePath("/melhores") é chamado por eles quando o rank muda.
export const dynamic = "force-dynamic";

const selFilme = {
  id: true, titulo: true, poster: true, ano: true, nota: true,
  urlDub: true, urlLeg: true, top250: true, popularRank: true,
} as const;

const selSerie = {
  id: true, titulo: true, poster: true, ano: true, nota: true,
  top250: true, popularRank: true,
  _count: { select: { episodios: true } },
} as const;

function filmeToChart(f: any, rankField: "top250" | "popularRank"): ChartItem {
  return {
    id: f.id,
    titulo: f.titulo,
    ano: f.ano ? String(f.ano) : "",
    nota: Math.round((f.nota ?? 0) * 10) / 10,
    poster: f.poster ? imgUrl(f.poster, "w185") : null,
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
    rank: s[rankField],
    disponivel: s._count.episodios > 0,
  };
}

export default async function MelhoresPage() {
  const [topFilmes, topSeries, popFilmes, popSeries] = await Promise.all([
    prisma.filme.findMany({ where: { top250: { not: null } }, orderBy: { top250: "asc" }, select: selFilme }),
    prisma.serie.findMany({ where: { top250: { not: null } }, orderBy: { top250: "asc" }, select: selSerie }),
    prisma.filme.findMany({ where: { popularRank: { not: null } }, orderBy: { popularRank: "asc" }, select: selFilme }),
    prisma.serie.findMany({ where: { popularRank: { not: null } }, orderBy: { popularRank: "asc" }, select: selSerie }),
  ]);

  return (
    <MelhoresClient
      topFilmes={topFilmes.map((f) => filmeToChart(f, "top250"))}
      topSeries={topSeries.map((s) => serieToChart(s, "top250"))}
      popFilmes={popFilmes.map((f) => filmeToChart(f, "popularRank"))}
      popSeries={popSeries.map((s) => serieToChart(s, "popularRank"))}
    />
  );
}
