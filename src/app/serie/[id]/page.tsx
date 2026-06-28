import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Play, Star, User } from "lucide-react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { imgUrl, getTVVideos, getTVCredits, getTVRecommendations, pickTrailer } from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { EpisodeGrid } from "./EpisodeGrid";
import { ContentRow } from "@/components/ui/ContentRow";
import { TrailerButton } from "@/components/ui/TrailerButton";
import { LikeButtons } from "@/components/ui/LikeButtons";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const serie = await prisma.serie.findUnique({ where: { id: params.id } });
  return { title: serie ? `${serie.titulo} — Obaflix` : "Obaflix" };
}

export default async function SeriePage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;

  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });

  if (!serie) notFound();

  const [episodios, videos, credits, tmdbRecs, episodeProgressList, continueEp] = await Promise.all([
    prisma.episodio.findMany({
      where: { serieId: serie.id },
      orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
    }),
    serie.tmdbId ? getTVVideos(serie.tmdbId) : null,
    serie.tmdbId ? getTVCredits(serie.tmdbId) : null,
    serie.tmdbId ? getTVRecommendations(serie.tmdbId) : null,
    userId
      ? prisma.watchHistory.findMany({
          where: { userId, serieId: serie.id, episodioId: { not: null } },
          select: { episodioId: true, progressoSeg: true, duracaoSeg: true, concluido: true },
        })
      : Promise.resolve([]),
    userId
      ? prisma.watchHistory.findFirst({
          where: { userId, serieId: serie.id, concluido: false, progressoSeg: { gt: 30 } },
          orderBy: { updatedAt: "desc" },
          select: { temporada: true, numeroEp: true },
        })
      : Promise.resolve(null),
  ]);

  const progressoMap: Record<string, { progressoSeg: number; duracaoSeg: number | null; concluido: boolean }> =
    Object.fromEntries(
      episodeProgressList.map((p) => [
        p.episodioId!,
        { progressoSeg: p.progressoSeg, duracaoSeg: p.duracaoSeg ?? null, concluido: p.concluido },
      ])
    );

  const temporadas = Array.from(new Set(episodios.map((e) => e.temporada))).sort((a, b) => a - b);
  const trailer = pickTrailer(videos?.results);
  const cast = (credits?.cast ?? []).slice(0, 16);

  // TMDB recommendations → match with DB
  let recCards: any[] = [];
  if (tmdbRecs?.results?.length) {
    const tmdbIds = tmdbRecs.results.map((r: any) => String(r.id));
    const dbRecs = await prisma.serie.findMany({
      where: { tmdbId: { in: tmdbIds } },
      select: { id: true, titulo: true, poster: true, ano: true, nota: true, tipo: true },
    });
    recCards = dbRecs.map((s) => ({ ...s, tipo: s.tipo as any }));
  }

  // Fallback: series do mesmo gênero
  if (!recCards.length) {
    const generoIds = serie.generos.map((g: any) => g.generoId);
    const fallback = await prisma.serie.findMany({
      where: { id: { not: serie.id }, generos: { some: { generoId: { in: generoIds } } } },
      take: 20,
      select: { id: true, titulo: true, poster: true, ano: true, nota: true, tipo: true },
    });
    recCards = fallback.map((s) => ({ ...s, tipo: s.tipo as any }));
  }

  return (
    <div className="min-h-screen">
      {/* Backdrop */}
      <div className="relative h-[65vh] min-h-[400px]">
        <Image
          src={serie.background ? imgUrl(serie.background, "original") : "/placeholder-bg.jpg"}
          alt={serie.titulo}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-r from-zinc-950/95 via-zinc-950/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-transparent" />
      </div>

      <div className="relative -mt-56 px-4 md:px-16 pb-16">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Poster */}
          <div className="shrink-0">
            <div className="w-40 md:w-56 rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10">
              <Image
                src={serie.poster ? imgUrl(serie.poster, "w342") : "/placeholder.jpg"}
                alt={serie.titulo}
                width={224}
                height={336}
                className="w-full object-cover"
              />
            </div>
          </div>

          {/* Info */}
          <div className="flex-1 pt-0 md:pt-12">
            <h1 className="text-3xl md:text-5xl font-black text-white mb-1 leading-tight">{serie.titulo}</h1>

            <div className="flex flex-wrap items-center gap-4 mb-4 text-sm text-zinc-400">
              {serie.ano && <span className="font-medium">{serie.ano}</span>}
              {serie.temporadas && (
                <span>{serie.temporadas} {serie.temporadas === 1 ? "temporada" : "temporadas"}</span>
              )}
              {serie.nota && (
                <span className="flex items-center gap-1.5 text-yellow-400 font-semibold">
                  <Star size={14} fill="currentColor" /> {serie.nota.toFixed(1)}
                </span>
              )}
              <span className="bg-zinc-800 text-zinc-300 text-xs px-2.5 py-1 rounded-full capitalize border border-zinc-700">
                {serie.tipo}
              </span>
            </div>

            <div className="flex flex-wrap gap-2 mb-5">
              {serie.generos.map((g: any) => (
                <Link key={g.generoId} href={`/genero/${g.generoId}`} className="text-xs bg-zinc-800 text-zinc-300 px-3 py-1 rounded-full border border-zinc-700 hover:bg-zinc-700 hover:text-white transition">
                  {g.genero.nome}
                </Link>
              ))}
            </div>

            {serie.sinopse && (
              <p className="text-zinc-300 text-sm md:text-base leading-relaxed mb-6 max-w-2xl">{serie.sinopse}</p>
            )}

            <div className="flex flex-wrap gap-3 mb-4">
              {continueEp ? (
                <Link
                  href={`/assistir/serie/${serie.id}/t${continueEp.temporada}/ep${continueEp.numeroEp}`}
                  className="flex items-center gap-2 bg-white text-black font-bold px-7 py-3 rounded-lg hover:bg-zinc-200 transition text-sm"
                >
                  <Play size={18} fill="black" /> Continuar
                </Link>
              ) : episodios[0] ? (
                <Link
                  href={`/assistir/serie/${serie.id}/t${episodios[0].temporada}/ep${episodios[0].numeroEp}`}
                  className="flex items-center gap-2 bg-white text-black font-bold px-7 py-3 rounded-lg hover:bg-zinc-200 transition text-sm"
                >
                  <Play size={18} fill="black" /> Assistir
                </Link>
              ) : null}
              {trailer && (
                <TrailerButton videoKey={trailer.key} titulo={serie.titulo} />
              )}
            </div>
            <LikeButtons conteudoId={serie.id} tipo={serie.tipo as any} />
          </div>
        </div>

        {/* Elenco */}
        {cast.length > 0 && (
          <div className="mt-12">
            <h2 className="text-white font-semibold text-lg mb-4">Elenco Principal</h2>
            <div className="flex gap-4 overflow-x-auto scrollbar-hide pb-2">
              {cast.map((person: any) => {
                const character = person.character ?? person.roles?.[0]?.character;
                return (
                  <div key={person.id} className="flex-none w-24 text-center">
                    <div className="w-24 h-24 rounded-full overflow-hidden bg-zinc-800 mb-2 mx-auto ring-2 ring-zinc-700">
                      {person.profile_path ? (
                        <Image
                          src={imgUrl(person.profile_path, "w185")}
                          alt={person.name}
                          width={96}
                          height={96}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-600">
                          <User size={32} />
                        </div>
                      )}
                    </div>
                    <p className="text-white text-xs font-semibold line-clamp-2 leading-tight">{person.name}</p>
                    {character && (
                      <p className="text-zinc-500 text-[10px] line-clamp-1 mt-0.5">{character}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Episódios */}
        <div className="mt-10">
          <EpisodeGrid serieId={serie.id} episodios={episodios} temporadas={temporadas} progresso={progressoMap} />
        </div>

        {/* Recomendações */}
        {recCards.length > 0 && (
          <div className="mt-10">
            <ContentRow titulo="Você Também Pode Gostar" items={recCards} />
          </div>
        )}
      </div>
    </div>
  );
}
