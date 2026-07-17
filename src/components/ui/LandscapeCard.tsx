"use client";

import Image from "next/image";
import Link from "next/link";
import { Play, Star } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

function imgFallback(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.currentTarget as HTMLImageElement).src = "/placeholder.jpg";
}

interface Props {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  background?: string | null;
  logo?: string | null;
  ano: number | null;
  nota: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  progresso?: { progressoSeg: number; duracaoSeg: number | null } | null;
  episodeLabel?: string | null;
  isNew?: boolean;
}

export function LandscapeCard({
  id, tipo, titulo, poster, background, logo, ano, nota,
  urlDub, urlLeg, progresso, episodeLabel, isNew,
}: Props) {
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;

  const posterSrc = poster ? imgUrl(poster, "w342") : "/placeholder.jpg";
  const bgSrc = background ? imgUrl(background, "w500") : posterSrc;
  const logoSrc = logo ? imgUrl(logo, "w300") : null;

  const pct = progresso?.duracaoSeg
    ? Math.min((progresso.progressoSeg / progresso.duracaoSeg) * 100, 100)
    : 0;

  return (
    <div className="relative group/card shrink-0 w-[140px] sm:w-[160px] md:w-[200px]">
      <Link href={href}>
        <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-zinc-900 cursor-pointer">

          {logoSrc ? (
            /* Logo mode — blurred backdrop + logo centralizado */
            <>
              <Image
                src={bgSrc}
                alt=""
                fill
                className="w-full h-full object-cover opacity-40 scale-110 blur-[2px] transition-opacity duration-300 group-hover/card:opacity-55"
                sizes="(max-width: 640px) 140px, (max-width: 768px) 160px, 200px"
                loading="lazy"
                onError={imgFallback}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-black/50" />
              <div className="absolute inset-0 flex items-center justify-center p-4 md:p-5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoSrc}
                  alt={titulo}
                  className="max-w-full max-h-[65%] object-contain drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)] transition-transform duration-300 group-hover/card:scale-105"
                />
              </div>
            </>
          ) : (
            /* Poster mode (fallback) */
            <Image
              src={posterSrc}
              alt={titulo}
              fill
              className="w-full h-full object-cover transition-transform duration-300 group-hover/card:scale-105"
              sizes="(max-width: 640px) 140px, (max-width: 768px) 160px, 200px"
              loading="lazy"
              onError={imgFallback}
            />
          )}

          {/* Hover gradient (poster mode only) */}
          {!logoSrc && (
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover/card:opacity-100 transition-opacity duration-200" />
          )}

          {/* Play button */}
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/card:opacity-100 transition-opacity duration-200">
            <div className="w-11 h-11 rounded-full bg-white/90 flex items-center justify-center">
              <Play size={18} fill="black" className="text-black ml-0.5" />
            </div>
          </div>

          {/* Top-right badges */}
          <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
            {isNew && !episodeLabel && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider text-emerald-300 bg-emerald-500/20 backdrop-blur">
                NOVO
              </span>
            )}
            {episodeLabel && (
              <span className="px-2 py-0.5 rounded text-[10px] font-semibold text-white bg-black/70 backdrop-blur">
                {episodeLabel}
              </span>
            )}
          </div>

          {/* DUB/LEG badges top-left */}
          {(urlDub || urlLeg) && !episodeLabel && (
            <div className="absolute top-2 left-2 flex gap-1">
              {urlDub && (
                <span className="bg-blue-600/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded backdrop-blur">
                  DUB
                </span>
              )}
              {urlLeg && !urlDub && (
                <span className="bg-zinc-700/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded backdrop-blur">
                  LEG
                </span>
              )}
            </div>
          )}

          {/* Progress bar */}
          {pct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/20">
              <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>

        <p className="mt-2 text-sm font-medium text-gray-200 truncate group-hover/card:text-white transition-colors duration-200">
          {titulo}
        </p>

        {nota ? (
          <div className="flex items-center gap-1 mt-0.5">
            <Star size={9} fill="#facc15" className="text-yellow-400 flex-none" />
            <span className="text-[11px] text-zinc-400">{nota.toFixed(1)}</span>
            {ano && <span className="text-[11px] text-zinc-600">· {ano}</span>}
          </div>
        ) : ano ? (
          <p className="text-[11px] text-zinc-600 mt-0.5">{ano}</p>
        ) : null}
      </Link>
    </div>
  );
}
