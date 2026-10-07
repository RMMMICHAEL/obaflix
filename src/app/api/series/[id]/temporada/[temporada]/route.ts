import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTVSeasonDetails } from "@/lib/tmdb";
import { extrairMetadataEpisodios } from "@/lib/tmdbEpisodios";

/**
 * Metadata PÚBLICA de UMA temporada, sob demanda.
 *
 * Existe para a ficha de série não precisar buscar os detalhes de TODAS as
 * temporadas no render inicial: a grade pede esta rota só quando o usuário troca
 * para uma temporada ainda não carregada (ver EpisodeGrid). A primeira temporada
 * já vem no HTML, então a troca é a única consumidora.
 *
 * Devolve apenas overview, runtime, thumbnail (still_path) e nota por episódio —
 * os mesmos campos que a grade já mostrava. NUNCA urlDub/urlLeg, provider, token,
 * URL de mídia ou dado de usuário: é só um recorte do TMDB, igual para todos os
 * visitantes, então pode ser cache público.
 *
 * `temporada` é validada como inteiro pequeno e o tmdbId vem do nosso banco (não
 * do cliente), então não há como apontar o fetch para uma URL arbitrária.
 */
export const revalidate = 86400;

const TEMPORADA_MAX = 1000;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; temporada: string } },
) {
  const temporada = Number(params.temporada);
  if (!Number.isInteger(temporada) || temporada < 0 || temporada > TEMPORADA_MAX) {
    return NextResponse.json({ error: "Temporada inválida" }, { status: 400 });
  }

  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    select: { tmdbId: true },
  });
  if (!serie) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });

  // Sem tmdbId não há metadata TMDB — resposta vazia válida (a grade usa os
  // dados locais do episódio).
  const details = serie.tmdbId ? await getTVSeasonDetails(serie.tmdbId, temporada) : null;
  const maps = extrairMetadataEpisodios([details]);

  return NextResponse.json(maps, {
    headers: {
      "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
}
