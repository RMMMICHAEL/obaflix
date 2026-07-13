import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCollection, imgUrl } from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { LandscapeCard } from "@/components/ui/LandscapeCard";

export const dynamic = "force-dynamic";

export default async function ColecaoPage({ params }: { params: { id: string } }) {
  const colecaoId = Number(params.id);
  if (isNaN(colecaoId)) return notFound();

  const colecao = await getCollection(colecaoId);
  if (!colecao) return notFound();

  const tmdbIds = (colecao.parts ?? []).map((p) => String(p.id));

  const dbFilmes = tmdbIds.length
    ? await prisma.filme.findMany({
        where: { tmdbId: { in: tmdbIds } },
        select: {
          id: true, tmdbId: true, titulo: true, poster: true,
          background: true, logo: true, ano: true, nota: true,
          urlDub: true, urlLeg: true,
        },
      })
    : [];

  const dbMap = new Map(dbFilmes.map((f) => [f.tmdbId!, f]));

  const sortedParts = [...(colecao.parts ?? [])].sort((a, b) =>
    (a.release_date ?? "0").localeCompare(b.release_date ?? "0")
  );

  const cards = sortedParts
    .map((part) => {
      const db = dbMap.get(String(part.id));
      if (!db) return null;
      return {
        id: db.id,
        tipo: "filme" as const,
        titulo: db.titulo ?? part.title ?? part.name ?? "",
        poster: db.poster ?? part.poster_path ?? null,
        background: db.background ?? part.backdrop_path ?? null,
        logo: null,
        ano: db.ano ?? (Number((part.release_date ?? "").slice(0, 4)) || null),
        nota: db.nota ?? part.vote_average ?? null,
        urlDub: db.urlDub ?? null,
        urlLeg: db.urlLeg ?? null,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const backdropUrl = colecao.backdrop_path
    ? imgUrl(colecao.backdrop_path, "original")
    : null;
  const posterUrl = colecao.poster_path
    ? imgUrl(colecao.poster_path, "w342")
    : null;

  return (
    <div className="min-h-screen bg-black">
      {/* Hero */}
      <div className="relative h-[45vh] md:h-[55vh] overflow-hidden">
        {backdropUrl && (
          <Image src={backdropUrl} alt={colecao.name} fill className="object-cover object-top" priority />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/20" />
        <div className="absolute inset-0 bg-gradient-to-r from-black/60 to-transparent" />

        {/* Back button */}
        <div className="absolute top-6 left-6 md:left-12">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-white/70 hover:text-white transition-colors text-sm"
          >
            <ArrowLeft size={16} />
            Voltar
          </Link>
        </div>

        <div className="absolute bottom-0 left-0 right-0 px-6 md:px-12 pb-8 flex items-end gap-6">
          {posterUrl && (
            <div className="hidden sm:block w-24 md:w-32 flex-shrink-0 rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10">
              <Image
                src={posterUrl}
                alt={colecao.name}
                width={128}
                height={192}
                className="w-full h-full object-cover"
              />
            </div>
          )}
          <div className="pb-1">
            <p className="text-white/40 text-[11px] uppercase tracking-widest mb-1.5 font-medium">
              Coleção
            </p>
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-white leading-tight">
              {colecao.name}
            </h1>
            <p className="text-white/40 text-sm mt-2">
              {cards.length > 0
                ? `${cards.length} ${cards.length === 1 ? "filme disponível" : "filmes disponíveis"} no catálogo`
                : "Nenhum filme disponível no catálogo"}
              {colecao.parts?.length && colecao.parts.length !== cards.length
                ? ` · ${colecao.parts.length} na franquia`
                : ""}
            </p>
          </div>
        </div>
      </div>

      {/* Content grid */}
      <div className="px-6 md:px-12 py-8">
        {cards.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-zinc-500 text-sm">
              Nenhum filme desta coleção está disponível no catálogo ainda.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-3 md:gap-4">
            {cards.map((card) => (
              <LandscapeCard key={card.id} {...card} />
            ))}
          </div>
        )}

        {colecao.overview && (
          <div className="mt-10 max-w-2xl">
            <h2 className="text-white font-semibold text-base mb-2">Sobre a coleção</h2>
            <p className="text-zinc-400 text-sm leading-relaxed">{colecao.overview}</p>
          </div>
        )}
      </div>
    </div>
  );
}
