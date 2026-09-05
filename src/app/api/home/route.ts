import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publicMedia } from "@/lib/publicMedia";
import { ORDEM_POPULARIDADE } from "@/lib/ranking";

export const dynamic = "force-dynamic";

export async function GET() {
  // "Em alta" e "Populares" seguem a MESMA regra do resto do site: popularidade
  // (a popularity do TMDB) em ordem decrescente, com nota como desempate. Nota
  // alta não é o mesmo que estar em alta — um clássico com 9,0 não é tendência —,
  // então ordenar destaques por nota trazia a lista errada. `popularidade` é o
  // campo que a sincronização mantém e que /api/filmes?ordem=popular e a fileira
  // de animes já usavam; aqui filmes e séries passam a usá-lo também.
  // Importada de @/lib/ranking, não copiada — ver o comentário acima.
  const porPopularidade = ORDEM_POPULARIDADE;

  const [lancamentosFilmes, lancamentosSeries, destaquesFilmes, destaquesSeries, animes, desenhos] =
    await Promise.all([
      prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: { createdAt: "desc" }, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.filme.findMany({ orderBy: porPopularidade, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: porPopularidade, take: 20, include: { generos: { include: { genero: true } } } }),
      prisma.serie.findMany({
        where: { tipo: "anime" },
        orderBy: porPopularidade,
        take: 20,
        include: { generos: { include: { genero: true } } },
      }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: porPopularidade, take: 20, include: { generos: { include: { genero: true } } } }),
    ]);

  const hero = [...lancamentosFilmes, ...lancamentosSeries]
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  return NextResponse.json({
    hero: hero.map(publicMedia),
    lancamentosFilmes: lancamentosFilmes.map(publicMedia),
    lancamentosSeries,
    destaquesFilmes: destaquesFilmes.map(publicMedia),
    destaquesSeries,
    animes,
    desenhos,
  });
}
