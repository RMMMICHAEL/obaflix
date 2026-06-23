import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Play, Star, Clock } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { ContentRow } from "@/components/ui/ContentRow";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const filme = await prisma.filme.findUnique({ where: { id: params.id } });
  return { title: filme ? `${filme.titulo} — Streamix` : "Streamix" };
}

export default async function FilmePage({ params }: { params: { id: string } }) {
  const filme = await prisma.filme.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });

  if (!filme) notFound();

  const generoIds = filme.generos.map((g: { generoId: number }) => g.generoId);

  const similares = await prisma.filme.findMany({
    where: {
      id: { not: filme.id },
      generos: { some: { generoId: { in: generoIds } } },
    },
    take: 20,
    include: { generos: { include: { genero: true } } },
  });

  return (
    <div className="min-h-screen">
      {/* backdrop */}
      <div className="relative h-[60vh] min-h-[360px]">
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

      {/* content */}
      <div className="relative -mt-48 px-4 md:px-16 pb-16">
        <div className="flex flex-col md:flex-row gap-8">
          {/* poster */}
          <div className="shrink-0">
            <div className="w-40 md:w-56 rounded-lg overflow-hidden shadow-2xl">
              <Image
                src={filme.poster ? imgUrl(filme.poster, "w342") : "/placeholder.jpg"}
                alt={filme.titulo}
                width={224}
                height={336}
                className="w-full object-cover"
              />
            </div>
          </div>

          {/* info */}
          <div className="flex-1 pt-0 md:pt-8">
            <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">{filme.titulo}</h1>
            {filme.tituloOriginal && filme.tituloOriginal !== filme.titulo && (
              <p className="text-zinc-400 text-sm mb-3">{filme.tituloOriginal}</p>
            )}

            <div className="flex flex-wrap items-center gap-3 mb-4 text-sm text-zinc-400">
              {filme.ano && <span>{filme.ano}</span>}
              {filme.duracao && (
                <span className="flex items-center gap-1"><Clock size={14} /> {Math.floor(filme.duracao / 60)}h {filme.duracao % 60}min</span>
              )}
              {filme.nota && (
                <span className="flex items-center gap-1 text-yellow-400"><Star size={14} fill="currentColor" /> {filme.nota.toFixed(1)}</span>
              )}
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              {filme.generos.map((g: { generoId: number; genero: { nome: string } }) => (
                <span key={g.generoId} className="text-xs bg-zinc-800 text-zinc-300 px-2.5 py-1 rounded-full">{g.genero.nome}</span>
              ))}
            </div>

            {filme.sinopse && <p className="text-zinc-300 text-sm leading-relaxed mb-6 max-w-2xl">{filme.sinopse}</p>}

            <div className="flex flex-wrap gap-3">
              <Link
                href={`/assistir/filme/${filme.id}`}
                className="flex items-center gap-2 bg-white text-black font-bold px-7 py-2.5 rounded hover:bg-zinc-200 transition"
              >
                <Play size={18} fill="black" /> Assistir
              </Link>
              {filme.urlDub && (
                <span className="bg-blue-700 text-white text-xs font-bold px-3 py-1 rounded self-center">DUB</span>
              )}
              {filme.urlLeg && (
                <span className="bg-zinc-700 text-white text-xs font-bold px-3 py-1 rounded self-center">LEG</span>
              )}
            </div>
          </div>
        </div>

        {/* similares */}
        <div className="mt-12">
          <ContentRow
            titulo="Você Também Pode Gostar"
            items={similares.map((f) => ({
              id: f.id,
              tipo: "filme" as const,
              titulo: f.titulo,
              poster: f.poster,
              ano: f.ano,
              nota: f.nota,
              urlDub: f.urlDub,
              urlLeg: f.urlLeg,
            }))}
          />
        </div>
      </div>
    </div>
  );
}
