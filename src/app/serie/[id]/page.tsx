import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Play, Star } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { EpisodeGrid } from "./EpisodeGrid";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const serie = await prisma.serie.findUnique({ where: { id: params.id } });
  return { title: serie ? `${serie.titulo} — Streamix` : "Streamix" };
}

export default async function SeriePage({ params }: { params: { id: string } }) {
  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });

  if (!serie) notFound();

  const episodios = await prisma.episodio.findMany({
    where: { serieId: serie.id },
    orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
  });

  const temporadas = Array.from(new Set(episodios.map((e) => e.temporada))).sort((a, b) => a - b);

  return (
    <div className="min-h-screen">
      <div className="relative h-[60vh] min-h-[360px]">
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

      <div className="relative -mt-48 px-4 md:px-16 pb-16">
        <div className="flex flex-col md:flex-row gap-8">
          <div className="shrink-0">
            <div className="w-40 md:w-56 rounded-lg overflow-hidden shadow-2xl">
              <Image
                src={serie.poster ? imgUrl(serie.poster, "w342") : "/placeholder.jpg"}
                alt={serie.titulo}
                width={224}
                height={336}
                className="w-full object-cover"
              />
            </div>
          </div>

          <div className="flex-1 pt-0 md:pt-8">
            <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">{serie.titulo}</h1>

            <div className="flex flex-wrap items-center gap-3 mb-4 text-sm text-zinc-400">
              {serie.ano && <span>{serie.ano}</span>}
              {serie.temporadas && <span>{serie.temporadas} temp.</span>}
              {serie.nota && (
                <span className="flex items-center gap-1 text-yellow-400"><Star size={14} fill="currentColor" /> {serie.nota.toFixed(1)}</span>
              )}
              <span className="bg-zinc-800 text-zinc-300 text-xs px-2 py-0.5 rounded capitalize">{serie.tipo}</span>
            </div>

            <div className="flex flex-wrap gap-2 mb-4">
              {serie.generos.map((g: { generoId: number; genero: { nome: string } }) => (
                <span key={g.generoId} className="text-xs bg-zinc-800 text-zinc-300 px-2.5 py-1 rounded-full">{g.genero.nome}</span>
              ))}
            </div>

            {serie.sinopse && <p className="text-zinc-300 text-sm leading-relaxed mb-6 max-w-2xl">{serie.sinopse}</p>}

            {episodios[0] && (
              <Link
                href={`/assistir/serie/${serie.id}/t${episodios[0].temporada}/ep${episodios[0].numeroEp}`}
                className="inline-flex items-center gap-2 bg-white text-black font-bold px-7 py-2.5 rounded hover:bg-zinc-200 transition"
              >
                <Play size={18} fill="black" /> Assistir
              </Link>
            )}
          </div>
        </div>

        <div className="mt-10">
          <EpisodeGrid serieId={serie.id} episodios={episodios} temporadas={temporadas} />
        </div>
      </div>
    </div>
  );
}
