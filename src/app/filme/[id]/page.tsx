import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Play, Star, Clock, User } from "lucide-react";
import { imgUrl, getMovieVideos, getMovieCredits, getMovieRecommendations, pickTrailer } from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { ContentRow } from "@/components/ui/ContentRow";
import { TrailerButton } from "@/components/ui/TrailerButton";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const filme = await prisma.filme.findUnique({ where: { id: params.id } });
  return { title: filme ? `${filme.titulo} — Obaflix` : "Obaflix" };
}

export default async function FilmePage({ params }: { params: { id: string } }) {
  const filme = await prisma.filme.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });

  if (!filme) notFound();

  const generoIds = filme.generos.map((g: any) => g.generoId);

  // Fetch TMDB data + DB similares in parallel
  const [videos, credits, tmdbRecs, dbSimilares] = await Promise.all([
    filme.tmdbId ? getMovieVideos(filme.tmdbId) : null,
    filme.tmdbId ? getMovieCredits(filme.tmdbId) : null,
    filme.tmdbId ? getMovieRecommendations(filme.tmdbId) : null,
    prisma.filme.findMany({
      where: { id: { not: filme.id }, generos: { some: { generoId: { in: generoIds } } } },
      take: 20,
      select: { id: true, titulo: true, poster: true, ano: true, nota: true, urlDub: true, urlLeg: true },
    }),
  ]);

  const trailer = pickTrailer(videos?.results);
  const cast = (credits?.cast ?? []).slice(0, 16);

  // If TMDB has recommendations, try to match with our DB
  let recCards: any[] = [];
  if (tmdbRecs?.results?.length) {
    const tmdbIds = tmdbRecs.results.map((r: any) => String(r.id));
    const dbRecs = await prisma.filme.findMany({
      where: { tmdbId: { in: tmdbIds } },
      select: { id: true, titulo: true, poster: true, ano: true, nota: true, urlDub: true, urlLeg: true },
    });
    recCards = dbRecs.map((f) => ({ ...f, tipo: "filme" as const }));
  }

  const similares = (recCards.length > 0 ? recCards : dbSimilares).map((f) => ({
    ...f,
    tipo: "filme" as const,
  }));

  return (
    <div className="min-h-screen">
      {/* Backdrop */}
      <div className="relative h-[65vh] min-h-[400px]">
        <Image
          src={filme.background ? imgUrl(filme.background, "original") : "/placeholder-bg.jpg"}
          alt={filme.titulo}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-r from-zinc-950/95 via-zinc-950/60 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-transparent" />
      </div>

      {/* Content */}
      <div className="relative -mt-56 px-4 md:px-16 pb-16">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Poster */}
          <div className="shrink-0">
            <div className="w-40 md:w-56 rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10">
              <Image
                src={filme.poster ? imgUrl(filme.poster, "w342") : "/placeholder.jpg"}
                alt={filme.titulo}
                width={224}
                height={336}
                className="w-full object-cover"
              />
            </div>
          </div>

          {/* Info */}
          <div className="flex-1 pt-0 md:pt-12">
            <h1 className="text-3xl md:text-5xl font-black text-white mb-1 leading-tight">{filme.titulo}</h1>
            {filme.tituloOriginal && filme.tituloOriginal !== filme.titulo && (
              <p className="text-zinc-500 text-sm mb-3 italic">{filme.tituloOriginal}</p>
            )}

            <div className="flex flex-wrap items-center gap-4 mb-4 text-sm text-zinc-400">
              {filme.ano && <span className="font-medium">{filme.ano}</span>}
              {filme.duracao && (
                <span className="flex items-center gap-1.5">
                  <Clock size={14} />
                  {Math.floor(filme.duracao / 60)}h {filme.duracao % 60}min
                </span>
              )}
              {filme.nota && (
                <span className="flex items-center gap-1.5 text-yellow-400 font-semibold">
                  <Star size={14} fill="currentColor" /> {filme.nota.toFixed(1)}
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-2 mb-5">
              {filme.generos.map((g: any) => (
                <span key={g.generoId} className="text-xs bg-zinc-800 text-zinc-300 px-3 py-1 rounded-full border border-zinc-700">
                  {g.genero.nome}
                </span>
              ))}
            </div>

            {filme.sinopse && (
              <p className="text-zinc-300 text-sm md:text-base leading-relaxed mb-6 max-w-2xl">{filme.sinopse}</p>
            )}

            <div className="flex flex-wrap gap-3 items-center">
              <Link
                href={`/assistir/filme/${filme.id}`}
                className="flex items-center gap-2 bg-white text-black font-bold px-7 py-3 rounded-lg hover:bg-zinc-200 transition text-sm"
              >
                <Play size={18} fill="black" /> Assistir
              </Link>
              {trailer && (
                <TrailerButton videoKey={trailer.key} titulo={filme.titulo} />
              )}
              {filme.urlDub && (
                <span className="bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg">DUB</span>
              )}
              {filme.urlLeg && (
                <span className="bg-zinc-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg">LEG</span>
              )}
            </div>
          </div>
        </div>

        {/* Cast */}
        {cast.length > 0 && (
          <div className="mt-12">
            <h2 className="text-white font-semibold text-lg mb-4">Elenco Principal</h2>
            <div className="flex gap-4 overflow-x-auto scrollbar-hide pb-2">
              {cast.map((person: any) => (
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
                  {person.character && (
                    <p className="text-zinc-500 text-[10px] line-clamp-1 mt-0.5">{person.character}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recommendations */}
        {similares.length > 0 && (
          <div className="mt-10">
            <ContentRow titulo="Você Também Pode Gostar" items={similares} />
          </div>
        )}
      </div>
    </div>
  );
}
