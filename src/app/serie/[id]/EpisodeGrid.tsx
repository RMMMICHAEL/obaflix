"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, ChevronDown, Clock3, Play, Star } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

interface Ep {
  id: string;
  serieId: string;
  numeroEp: number;
  temporada: number;
  titulo: string | null;
  thumbnail: string | null;
  urlDub: string | null;
  urlLeg: string | null;
  createdAt: Date;
}

interface EpProgress {
  progressoSeg: number;
  duracaoSeg: number | null;
  concluido: boolean;
}

interface EpMetadata {
  overview: string | null;
  runtime: number | null;
  thumbnail: string | null;
}

export function EpisodeGrid({
  serieId,
  episodios,
  temporadas,
  progresso = {},
  ratingMap = {},
  metadataMap = {},
  initialSeason,
}: {
  serieId: string;
  episodios: Ep[];
  temporadas: number[];
  progresso?: Record<string, EpProgress>;
  ratingMap?: Record<string, number>;
  metadataMap?: Record<string, EpMetadata>;
  initialSeason?: number;
}) {
  const [temp, setTemp] = useState(initialSeason ?? temporadas[0] ?? 1);
  const eps = episodios.filter((e) => e.temporada === temp);
  const seasonCounts = new Map(temporadas.map((season) => [season, episodios.filter((ep) => ep.temporada === season).length]));

  const isNovo = (d: Date) => Date.now() - new Date(d).getTime() < 7 * 24 * 3600 * 1000;

  return (
    <section aria-labelledby="episodes-heading">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-4 border-b border-zinc-700 pb-4">
        <div>
          <h2 id="episodes-heading" className="text-xl font-bold text-zinc-100 md:text-2xl">Episódios</h2>
          <p className="mt-1 text-xs text-zinc-500">{eps.length} {eps.length === 1 ? "episódio" : "episódios"} nesta temporada</p>
        </div>
        <label className="relative">
          <span className="sr-only">Selecionar temporada</span>
          <select
            value={temp}
            onChange={(event) => setTemp(Number(event.target.value))}
            className="min-h-11 appearance-none rounded-md border border-zinc-600 bg-zinc-900 py-2 pl-4 pr-10 text-sm font-semibold text-zinc-100 outline-none transition-colors hover:border-zinc-400 focus:border-zinc-300 focus:ring-2 focus:ring-red-500/60"
          >
            {temporadas.map((season) => (
              <option key={season} value={season}>Temporada {season} ({seasonCounts.get(season) ?? 0})</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400" size={17} aria-hidden="true" />
        </label>
      </header>

      <div className="divide-y divide-zinc-800">
        {eps.map((ep) => {
          const p = progresso[ep.id];
          const isWatched = p?.concluido === true;
          const isWatching = !isWatched && !!p && p.progressoSeg > 30;
          const watchPct =
            isWatching && p.duracaoSeg
              ? Math.min(100, (p.progressoSeg / p.duracaoSeg) * 100)
              : 0;
          const epRating = ratingMap[`${ep.temporada}_${ep.numeroEp}`];
          const metadata = metadataMap[`${ep.temporada}_${ep.numeroEp}`];
          const thumbnail = ep.thumbnail ?? metadata?.thumbnail;

          return (
            <Link
              key={ep.id}
              href={`/assistir/serie/${serieId}/t${ep.temporada}/ep${ep.numeroEp}`}
              className="group grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 py-4 transition-colors duration-200 hover:bg-zinc-900/70 focus-visible:bg-zinc-900/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 sm:grid-cols-[2.5rem_11rem_minmax(0,1fr)] sm:px-3"
            >
              <span className="hidden text-center text-lg tabular-nums text-zinc-500 sm:block">{ep.numeroEp}</span>

              <div className="relative aspect-video overflow-hidden rounded-md bg-zinc-800">
                {thumbnail ? (
                  <Image src={imgUrl(thumbnail, "w300")} alt={ep.titulo ?? `Episódio ${ep.numeroEp}`} fill className="object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Play size={20} className="text-zinc-600" />
                  </div>
                )}

                <span className="absolute left-1.5 top-1.5 rounded bg-zinc-950/85 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-zinc-200 sm:hidden">
                  {ep.numeroEp}
                </span>

                {/* Overlay assistido */}
                {isWatched && (
                  <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600">
                      <Check size={16} className="text-white" strokeWidth={3} />
                    </div>
                  </div>
                )}

                {/* Overlay hover */}
                <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Play size={24} className="text-white" fill="white" />
                </div>

                {/* Barra de progresso no thumbnail */}
                {isWatching && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-950/50">
                    <div className="h-full bg-red-600" style={{ width: `${watchPct}%` }} />
                  </div>
                )}
              </div>

              <div className="min-w-0 py-1">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 text-sm font-semibold leading-snug text-zinc-100 sm:text-base">
                    {ep.titulo ?? `Episódio ${ep.numeroEp}`}
                  </p>
                  {metadata?.runtime && (
                    <span className="hidden shrink-0 items-center gap-1 text-xs text-zinc-500 md:flex">
                      <Clock3 size={12} aria-hidden="true" /> {metadata.runtime}min
                    </span>
                  )}
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {epRating && (
                    <span className="flex items-center gap-0.5 text-[10px] font-semibold text-amber-400">
                      <Star size={9} fill="currentColor" /> {epRating.toFixed(1)}
                    </span>
                  )}
                  {isNovo(ep.createdAt) && !isWatched && (
                    <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">NOVO</span>
                  )}
                  {isWatched && (
                    <span className="rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] font-bold text-white">ASSISTIDO</span>
                  )}
                  {isWatching && (
                    <span className="rounded bg-amber-600 px-1.5 py-0.5 text-[10px] font-bold text-white">CONTINUAR</span>
                  )}
                  {ep.urlDub && <span className="rounded bg-blue-700 px-1.5 py-0.5 text-[10px] font-bold text-white">DUB</span>}
                  {ep.urlLeg && <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] font-bold text-white">LEG</span>}
                  {metadata?.runtime && <span className="text-[10px] text-zinc-500 md:hidden">{metadata.runtime}min</span>}
                </div>

                {metadata?.overview && (
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-zinc-500 sm:text-sm">{metadata.overview}</p>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
