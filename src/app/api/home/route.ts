import { filmeDisponivel, serieDisponivel } from "@/lib/catalog-availability";
import { getBrazilSeriesRanking, orderBrazilSeriesRows } from "@/lib/brazil-series-ranking";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publicMedia } from "@/lib/publicMedia";
import { ORDEM_POPULARIDADE } from "@/lib/ranking";

export const dynamic = "force-dynamic";

export async function GET() {
  // Filmes/animes/desenhos mantêm TMDB. Destaques de séries: Brasil 7d.
  const brWeekIds = await getBrazilSeriesRanking("week", 20);
  const porPopularidade = ORDEM_POPULARIDADE;

  const [lancamentosFilmes, lancamentosSeries, destaquesFilmes, destaquesSeries, animes, desenhos] =
    await Promise.all([
      prisma.filme.findMany({ where: filmeDisponivel(), orderBy: { createdAt: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie" }), orderBy: { createdAt: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.filme.findMany({ where: filmeDisponivel(), orderBy: porPopularidade, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({ where: serieDisponivel({ id: { in: brWeekIds } }), include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({
        where: serieDisponivel({ tipo: "anime" }),
        orderBy: porPopularidade,
        take: 20,
        include: { generos: { include: { genero: true } } },
      }),
      prisma.serie.findMany({ where: serieDisponivel({ tipo: "desenho" }), orderBy: porPopularidade, take: 20, include: { generos: { include: { genero: true } } } }),
    ]);

  const hero = [...lancamentosFilmes, ...lancamentosSeries]
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  return NextResponse.json({
    hero: hero.map(publicMedia),
    lancamentosFilmes: lancamentosFilmes.map(publicMedia),
    lancamentosSeries,
    destaquesFilmes: destaquesFilmes.map(publicMedia),
    destaquesSeries: orderBrazilSeriesRows(brWeekIds, destaquesSeries),
    animes,
    desenhos,
  });
}
