import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTVCredits, getSerie } from "@/lib/tmdb";
import { extrairPessoasSerie } from "@/lib/tmdbPessoas";

/**
 * Elenco + criação/direção de uma série, sob demanda.
 *
 * Fica fora da geração da ficha (/serie/[id] é ISR estática: Suspense no servidor
 * NÃO adianta o hero no render frio — medido). A grade/ficha carrega estes dados
 * depois, pelo navegador, então o trabalho secundário não participa do ISR.
 *
 * Devolve apenas nome, papel/personagem e profile_path. NUNCA fonte de mídia,
 * provider, token, urlDub/urlLeg ou dado de usuário. Sucesso é cache público.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    select: { tmdbId: true },
  });
  if (!serie) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });

  // Sem tmdbId não há créditos TMDB — vazio válido e cacheável.
  if (!serie.tmdbId) {
    return NextResponse.json(
      { criacaoDirecao: [], elenco: [] },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
    );
  }

  const [credits, details] = await Promise.all([
    getTVCredits(serie.tmdbId),
    getSerie(serie.tmdbId),
  ]);

  // credits null = timeout/erro transitório do TMDB. Como há tmdbId, não pode
  // virar elenco vazio cacheado por 24h: 503 sem cache para o cliente tentar de
  // novo (padrão da 1A.1). O corpo não revela nada da origem.
  if (!credits) {
    return NextResponse.json(
      { error: "Créditos temporariamente indisponíveis" },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
    );
  }

  const pessoas = extrairPessoasSerie(credits, details);
  return NextResponse.json(pessoas, {
    headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
  });
}
