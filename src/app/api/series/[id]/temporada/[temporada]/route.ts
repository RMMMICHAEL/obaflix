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
 * visitantes, então o sucesso pode ser cache público.
 *
 * `temporada` é validada como inteiro pequeno E precisa existir localmente (há
 * episódio dessa temporada); o tmdbId vem do nosso banco (não do cliente), então
 * não há como apontar o fetch para uma URL arbitrária nem disparar chamadas ao
 * TMDB para temporadas inexistentes.
 */
export const dynamic = "force-dynamic";

const TEMPORADA_MAX = 1000;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; temporada: string } },
) {
  const temporada = Number(params.temporada);
  if (!Number.isInteger(temporada) || temporada < 0 || temporada > TEMPORADA_MAX) {
    return NextResponse.json({ error: "Temporada inválida" }, { status: 400 });
  }

  // UMA consulta: a série existe E tem ao menos um episódio dessa temporada. Sem
  // isto, um serieId válido permitiria disparar fetches ao TMDB para centenas de
  // temporadas inexistentes. Sem COUNT, sem segunda consulta.
  const serie = await prisma.serie.findFirst({
    where: { id: params.id, episodios: { some: { temporada } } },
    select: { tmdbId: true },
  });
  if (!serie) return NextResponse.json({ error: "Não encontrado" }, { status: 404 });

  // Sem tmdbId não há metadata TMDB — resposta vazia válida e cacheável (a grade
  // usa os dados locais do episódio). Não é falha, é ausência legítima de dado.
  if (!serie.tmdbId) {
    return NextResponse.json(extrairMetadataEpisodios([null]), {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  }

  const details = await getTVSeasonDetails(serie.tmdbId, temporada);

  // getTVSeasonDetails devolve null também em timeout/erro da origem. Como a
  // temporada EXISTE localmente, null aqui é falha transitória — não pode virar
  // `{}` cacheado por 24h. 503 sem cache + Retry-After curto para o cliente
  // tentar de novo; a resposta não revela nada da origem.
  if (!details) {
    return NextResponse.json(
      { error: "Metadata temporariamente indisponível" },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
    );
  }

  const maps = extrairMetadataEpisodios([details]);
  return NextResponse.json(maps, {
    headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
  });
}
