import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTVRecommendations } from "@/lib/tmdb";

/**
 * "Conteúdos parecidos" de uma série, sob demanda (fora do ISR da ficha).
 *
 * Recomendações do TMDB casadas com o nosso catálogo; se o TMDB não trouxer nada
 * (ou estiver indisponível), cai no fallback por gênero — sempre uma resposta
 * válida, por isso cacheável. Devolve só campos de card público (id, título,
 * arte, ano, nota, tipo). NUNCA fonte de mídia, provider, token, urlDub/urlLeg
 * ou dado de usuário.
 */
export const dynamic = "force-dynamic";

const SEL = {
  id: true, titulo: true, poster: true, background: true,
  logo: true, ano: true, nota: true, tipo: true,
} as const;

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    select: { tmdbId: true, generos: { select: { generoId: true } } },
  });
  if (!serie) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });

  let items: any[] = [];

  if (serie.tmdbId) {
    const recs = await getTVRecommendations(serie.tmdbId);
    if (recs?.results?.length) {
      const tmdbIds = recs.results.map((r: any) => String(r.id));
      const dbRecs = await prisma.serie.findMany({ where: { tmdbId: { in: tmdbIds } }, select: SEL });
      items = dbRecs.map((s) => ({ ...s, tipo: s.tipo as any }));
    }
  }

  // Fallback por gênero quando não há recomendação casada (inclui TMDB indispon.).
  if (!items.length) {
    const generoIds = serie.generos.map((g) => g.generoId);
    const fallback = await prisma.serie.findMany({
      where: { id: { not: params.id }, generos: { some: { generoId: { in: generoIds } } } },
      take: 20,
      select: SEL,
    });
    items = fallback.map((s) => ({ ...s, tipo: s.tipo as any }));
  }

  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
  );
}
