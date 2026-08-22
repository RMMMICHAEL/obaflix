"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, ChevronLeft, ChevronRight, Play, Star } from "lucide-react";
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
  const seasonsRef = useRef<HTMLDivElement>(null);

  const scrollSeasons = (dir: "left" | "right") =>
    seasonsRef.current?.scrollBy({ left: dir === "left" ? -320 : 320, behavior: "smooth" });

  const isNovo = (d: Date) => Date.now() - new Date(d).getTime() < 7 * 24 * 3600 * 1000;

  if (!temporadas.length) return null;

  return (
    <section aria-labelledby="episodes-heading">
      <h2 id="episodes-heading" className="sr-only">
        Episódios
      </h2>

      {/* Seletor de temporadas: continua em lista horizontal de pilulas. */}
      <div className="relative mb-5">
        {temporadas.length > 3 && (
          <>
            <SeasonArrow side="left" onClick={() => scrollSeasons("left")} />
            <SeasonArrow side="right" onClick={() => scrollSeasons("right")} />
          </>
        )}
        <div
          ref={seasonsRef}
          className="scrollbar-hide flex gap-2.5 overflow-x-auto scroll-smooth px-1 py-1"
        >
          {temporadas.map((season) => {
            const ativa = season === temp;
            return (
              <button
                key={season}
                type="button"
                onClick={() => setTemp(season)}
                aria-pressed={ativa}
                className={`shrink-0 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 ${
                  ativa
                    ? "bg-zinc-800 text-white ring-1 ring-white/15"
                    : "bg-white/[0.04] text-zinc-400 ring-1 ring-white/[0.07] hover:bg-white/10 hover:text-zinc-100"
                }`}
              >
                Temporada {season}
              </button>
            );
          })}
        </div>
      </div>

      {/*
        Episodios empilhados numa coluna so. O banner 16:9 fica a esquerda com
        largura fixa em vez de ocupar a linha inteira: num item de lista, uma
        imagem de largura total empurraria titulo e sinopse para fora da tela a
        cada episodio e a leitura vertical se perderia.
      */}
      <ol className="flex flex-col divide-y divide-white/[0.06]">
        {eps.map((ep) => {
          const p = progresso[ep.id];
          const isWatched = p?.concluido === true;
          const isWatching = !isWatched && !!p && p.progressoSeg > 30;
          const watchPct =
            isWatching && p.duracaoSeg ? Math.min(100, (p.progressoSeg / p.duracaoSeg) * 100) : 0;
          const metadata = metadataMap[`${ep.temporada}_${ep.numeroEp}`];
          const epRating = ratingMap[`${ep.temporada}_${ep.numeroEp}`];
          const thumbnail = ep.thumbnail ?? metadata?.thumbnail;

          return (
            <li key={ep.id}>
              <Link
                href={`/assistir/serie/${serieId}/t${ep.temporada}/ep${ep.numeroEp}`}
                className="group/card flex items-start gap-3 rounded-xl py-3 transition-colors duration-200 hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 sm:gap-4 sm:px-2"
              >
                <div className="relative aspect-video w-[9.5rem] shrink-0 overflow-hidden rounded-xl bg-zinc-900 ring-1 ring-white/[0.07] transition-all duration-200 group-hover/card:ring-white/25 sm:w-[13rem] md:w-[15rem]">
                  {thumbnail ? (
                    <Image
                      src={imgUrl(thumbnail, "w500")}
                      alt={ep.titulo ?? `Episódio ${ep.numeroEp}`}
                      fill
                      sizes="(max-width: 640px) 152px, (max-width: 768px) 208px, 240px"
                      className="object-cover transition-transform duration-300 group-hover/card:scale-[1.04]"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Play size={22} className="text-zinc-700" />
                    </div>
                  )}

                  {/* Play no hover */}
                  <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/45 opacity-0 transition-opacity duration-200 group-hover/card:opacity-100 group-focus-visible/card:opacity-100">
                    <span className="grid h-11 w-11 place-items-center rounded-full bg-white/95 shadow-lg">
                      <Play size={18} className="translate-x-[1px] text-black" fill="black" strokeWidth={0} />
                    </span>
                  </div>

                  {isWatched && (
                    <span className="absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-emerald-600 shadow">
                      <Check size={13} className="text-white" strokeWidth={3} />
                    </span>
                  )}

                  <div className="absolute bottom-2 left-2 flex flex-wrap items-center gap-1.5">
                    {isNovo(ep.createdAt) && !isWatched && (
                      <Badge className="bg-red-600 text-white">NOVO</Badge>
                    )}
                    {ep.urlDub && <Badge className="bg-zinc-950/80 text-zinc-100">DUB</Badge>}
                    {ep.urlLeg && <Badge className="bg-zinc-950/80 text-zinc-100">LEG</Badge>}
                  </div>

                  {metadata?.runtime && (
                    <span className="absolute bottom-2 right-2 rounded bg-zinc-950/80 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-zinc-100 backdrop-blur-sm">
                      {metadata.runtime}min
                    </span>
                  )}

                  {isWatching && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-950/60">
                      <div className="h-full bg-red-600" style={{ width: `${watchPct}%` }} />
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1 py-0.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-semibold leading-snug text-zinc-100 transition-colors group-hover/card:text-white sm:text-base">
                      {ep.numeroEp}. {ep.titulo ?? `Episódio ${ep.numeroEp}`}
                    </p>
                    {epRating && (
                      <span className="flex shrink-0 items-center gap-0.5 pt-0.5 text-[11px] font-semibold text-amber-400">
                        <Star size={10} fill="currentColor" strokeWidth={0} /> {epRating.toFixed(1)}
                      </span>
                    )}
                  </div>
                  {metadata?.overview && (
                    <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-zinc-500 sm:line-clamp-3 sm:text-sm">
                      {metadata.overview}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold backdrop-blur-sm ${className}`}>
      {children}
    </span>
  );
}

function SeasonArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Temporadas anteriores" : "Próximas temporadas"}
      className={`absolute top-1/2 z-20 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-zinc-800/90 text-white shadow-lg ring-1 ring-white/10 backdrop-blur-sm transition-colors hover:bg-zinc-700 md:grid ${
        side === "left" ? "-left-2" : "-right-2"
      }`}
    >
      <Icon size={18} />
    </button>
  );
}
