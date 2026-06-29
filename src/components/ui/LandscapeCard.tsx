"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Play, Star } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

interface Props {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  background?: string | null;
  ano: number | null;
  nota: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  progresso?: { progressoSeg: number; duracaoSeg: number | null } | null;
  episodeLabel?: string | null;
  isNew?: boolean;
}

export function LandscapeCard({
  id, tipo, titulo, poster, background, ano, nota,
  urlDub, urlLeg, progresso, episodeLabel, isNew,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;

  const imgSrc = background
    ? imgUrl(background, "w780")
    : poster
    ? imgUrl(poster, "w342")
    : "/placeholder-bg.jpg";

  const pct = progresso?.duracaoSeg
    ? Math.min((progresso.progressoSeg / progresso.duracaoSeg) * 100, 100)
    : 0;

  return (
    <div
      className="flex-none w-40 sm:w-44 md:w-56 group/card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link href={href} className="block">
        {/* Card image container */}
        <div className="relative aspect-video rounded overflow-hidden bg-zinc-900 transition-transform duration-200 group-hover/card:scale-[1.04] group-hover/card:z-10 shadow-md group-hover/card:shadow-xl">
          <Image
            src={imgSrc}
            alt={titulo}
            fill
            className="object-cover"
            sizes="(max-width: 640px) 160px, (max-width: 768px) 176px, 224px"
          />

          {/* Hover overlay — shows title + meta */}
          <div
            className={`absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-black/20 flex flex-col justify-between p-2 transition-opacity duration-150 ${
              hovered ? "opacity-100" : "opacity-0"
            }`}
          >
            {/* Top: badges */}
            <div className="flex gap-1">
              {urlDub && (
                <span className="bg-blue-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">DUB</span>
              )}
              {urlLeg && (
                <span className="bg-zinc-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">LEG</span>
              )}
            </div>

            {/* Center: play */}
            <div className="flex items-center justify-center">
              <div className="w-8 h-8 rounded-full bg-white/25 backdrop-blur-sm flex items-center justify-center border border-white/40 group-hover/card:bg-white/35 transition">
                <Play size={13} fill="white" className="text-white ml-0.5" />
              </div>
            </div>

            {/* Bottom: title + meta */}
            <div>
              <p className="text-white text-[11px] font-semibold line-clamp-1 mb-0.5">{titulo}</p>
              <div className="flex items-center gap-2">
                {episodeLabel && (
                  <span className="text-white/70 text-[9px] font-medium">{episodeLabel}</span>
                )}
                {ano && <span className="text-zinc-400 text-[9px]">{ano}</span>}
                {nota && (
                  <span className="flex items-center gap-0.5 text-yellow-400 text-[9px]">
                    <Star size={7} fill="currentColor" /> {nota.toFixed(1)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Static badges (always visible, hide on hover) */}
          {!hovered && (
            <>
              {episodeLabel && (
                <div className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-sm backdrop-blur-sm">
                  {episodeLabel}
                </div>
              )}
              {(urlDub || urlLeg) && !episodeLabel && (
                <div className="absolute top-1.5 left-1.5 flex gap-1">
                  {urlDub && (
                    <span className="bg-blue-600/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm backdrop-blur-sm">DUB</span>
                  )}
                  {urlLeg && !urlDub && (
                    <span className="bg-zinc-700/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm backdrop-blur-sm">LEG</span>
                  )}
                </div>
              )}
            </>
          )}

          {/* Badge "Recém Adicionado" — full-width centrado, igual 1Flex "Recently Added" */}
          {isNew && !progresso && (
            <div className="absolute bottom-0 left-0 right-0 bg-red-600 text-white text-[9px] font-semibold text-center py-[3px] tracking-wide">
              Recém Adicionado
            </div>
          )}

          {/* Progress bar */}
          {pct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/20">
              <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </Link>

      {/* Title: visible only on mobile (desktop shows in hover overlay) */}
      <p className="md:hidden text-zinc-400 text-[11px] font-medium mt-1 truncate leading-tight px-0.5">
        {titulo}
      </p>
    </div>
  );
}
