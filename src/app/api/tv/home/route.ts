import { filmeDisponivel, serieDisponivel } from "@/lib/catalog-availability";
import { getBrazilSeriesRanking, orderBrazilSeriesRows } from "@/lib/brazil-series-ranking";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getImdbTop250Showcases } from "@/lib/catalog-showcases";
import { LIMITE_TOP10, LIMITE_VITRINE, ORDEM_POPULARIDADE, ORDEM_TOP10 } from "@/lib/ranking";

export const dynamic = "force-dynamic";

/**
 * Home do aplicativo de TV, montada numa requisição só.
 *
 * Reaproveita EXATAMENTE as regras que a home do site (src/app/page.tsx) já usa
 * — TMDB para filmes; Brasil 7d/24h para séries populares/Top 10;
 * IMDb Top 250 local para "mais bem avaliados", createdAt para "novos". Nada de
 * lógica nova nem de ordenar destaque por nota alta (que trazia clássico, não
 * tendência). É um endpoint separado do /api/home para não mexer no que o app
 * móvel já consome; a TV guarda o resultado em memória e só o pede uma vez por
 * sessão, então o custo extra é pago no máximo uma vez por abertura.
 */

const selBase = {
  id: true,
  titulo: true,
  poster: true,
  background: true,
  logo: true,
  sinopse: true,
  ano: true,
  nota: true,
  generos: { select: { genero: { select: { id: true, nome: true } } } },
} as const;

// Filme não tem coluna `tipo`; a série tem. O `tipo` do filme é adicionado no
// mapeamento (sempre "filme").
const selFilme = selBase;
const sel = { ...selBase, tipo: true } as const;

// Mesma ordenação do site, do Electron e do aplicativo móvel — importada, não
// copiada. A cópia local que existia aqui era metade do motivo de a TV mostrar
// uma lista diferente da do aplicativo; a outra metade era a falta de um
// desempate determinístico, que agora vive em @/lib/ranking.
const POR_POPULARIDADE = ORDEM_POPULARIDADE;

/** Categorias em destaque na Home. O termo casa filme e série (ex.: "Ação" e
 *  "Ação & Aventura") por busca no nome do gênero, sem depender de id fixo. */
const CATEGORIAS: { titulo: string; termo: string }[] = [
  { titulo: "Ação", termo: "Ação" },
  { titulo: "Comédia", termo: "Comédia" },
  { titulo: "Terror", termo: "Terror" },
  { titulo: "Ficção Científica", termo: "Ficção" },
  { titulo: "Drama", termo: "Drama" },
  { titulo: "Suspense", termo: "Suspense" },
  { titulo: "Romance", termo: "Romance" },
  { titulo: "Animação", termo: "Animação" },
  { titulo: "Família", termo: "Família" },
];

/** Intercala duas listas — filme, série, filme, série… — para uma linha mista. */
function intercalar<T>(a: T[], b: T[], limite: number): T[] {
  const saida: T[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && saida.length < limite; i++) {
    if (a[i]) saida.push(a[i]);
    if (b[i]) saida.push(b[i]);
  }
  return saida.slice(0, limite);
}

export async function GET() {
  const [brWeekIds, brDayIds] = await Promise.all([
    getBrazilSeriesRanking("week", LIMITE_VITRINE),
    getBrazilSeriesRanking("day", LIMITE_TOP10),
  ]);
  const filme = (extra: object, orderBy: object, take: number) =>
    prisma.filme.findMany({ where: filmeDisponivel(extra as never), orderBy: orderBy as never, take, select: selFilme });
  const serie = (tipo: string, extra: object, orderBy: object, take: number) =>
    prisma.serie.findMany({ where: serieDisponivel({ tipo, ...extra } as never), orderBy: orderBy as never, take, select: sel });

  const [
    popFilmes,
    popSeriesRaw,
    top10Filmes,
    top10SeriesRaw,
    imdbTop250,
    novosFilmes,
    novasSeries,
  ] = await Promise.all([
    filme({}, POR_POPULARIDADE, LIMITE_VITRINE),
    prisma.serie.findMany({ where: serieDisponivel({ id: { in: brWeekIds } }), select: sel }),
    filme({ popularRank: { not: null } }, ORDEM_TOP10, LIMITE_TOP10),
    prisma.serie.findMany({ where: serieDisponivel({ id: { in: brDayIds } }), select: sel }),
    getImdbTop250Showcases(),
    filme({}, { createdAt: "desc" }, LIMITE_VITRINE),
    serie("serie", {}, { createdAt: "desc" }, LIMITE_VITRINE),
  ]);
  const popSeries = orderBrazilSeriesRows(brWeekIds, popSeriesRaw);
  const top10Series = orderBrazilSeriesRows(brDayIds, top10SeriesRaw);

  // "Em alta": mistura os mais populares de filmes e séries. É o que o site
  // trata como tendência, sem depender de cruzar com a lista ao vivo do TMDB.
  const emAlta = intercalar(
    popFilmes.map((f) => ({ ...f, tipo: "filme" })),
    popSeries,
    20,
  );

  // Categorias: filme + série em destaque de cada gênero, por popularidade.
  const categoriasRaw = await Promise.all(
    CATEGORIAS.map(async ({ titulo, termo }) => {
      const filtro = { generos: { some: { genero: { nome: { contains: termo, mode: "insensitive" as const } } } } };
      const [f, s] = await Promise.all([
        prisma.filme.findMany({ where: filmeDisponivel(filtro), orderBy: POR_POPULARIDADE, take: 10, select: selFilme }),
        prisma.serie.findMany({ where: serieDisponivel({ tipo: "serie", ...filtro }), orderBy: POR_POPULARIDADE, take: 10, select: sel }),
      ]);
      return { titulo, itens: intercalar(f.map((x) => ({ ...x, tipo: "filme" })), s, 16) };
    }),
  );
  const categorias = categoriasRaw.filter((c) => c.itens.length > 0);

  return NextResponse.json({
    emAlta,
    popularesFilmes: popFilmes,
    top10Filmes,
    avaliadosFilmes: imdbTop250.filmes,
    novosFilmes,
    popularesSeries: popSeries,
    top10Series,
    avaliadosSeries: imdbTop250.series,
    novasSeries,
    categorias,
  });
}
