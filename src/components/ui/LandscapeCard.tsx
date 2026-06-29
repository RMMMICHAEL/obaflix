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
  id, tipo, titulo, poster, background, ano, nota,
  urlDub, urlLeg, progresso, episodeLabel, isNew,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;

  const backdropSrc = background
    ? imgUrl(background, "w780")
    : poster
    ? imgUrl(poster, "w342")
    : "/placeholder-bg.jpg";

  const posterSrc = poster
    ? imgUrl(poster, "w342")
    : background
    ? imgUrl(background, "w780")
    : "/placeholder.jpg";

  const pct = progresso?.duracaoSeg
    ? Math.min((progresso.progressoSeg / progresso.duracaoSeg) * 100, 100)
    : 0;

  return (
    <div
      className="flex-none w-28 sm:w-32 md:w-56 group/card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link href={href} className="block">

        {/* ── DESKTOP: backdrop 16:9 (banner com título embutido, estilo 1Flex) ── */}
        <div className="hidden md:block relative aspect-video rounded overflow-hidden bg-zinc-900 transition-transform duration-200 group-hover/card:scale-[1.03] shadow-md group-hover/card:shadow-xl">
          <Image
            src={backdropSrc}
            alt={titulo}
            fill
            className={`object-cover transition-opacity duration-200 ${hovered ? "brightness-75" : ""}`}
            sizes="224px"
          />

          {/* Hover overlay (desktop) */}
          <div className={`absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex flex-col justify-between p-2 transition-opacity duration-150 ${hovered ? "opacity-100" : "opacity-0"}`}>
            <div className="flex gap-1">
              {urlDub && <span className="bg-blue-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">DUB</span>}
              {urlLeg && <span className="bg-zinc-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">LEG</span>}
            </div>
            <div className="flex items-center justify-center">
              <div className="w-9 h-9 rounded-full bg-white/25 backdrop-blur-sm flex items-center justify-center border border-white/50">
                <Play size={14} fill="white" className="text-white ml-0.5" />
              </div>
            </div>
            <div>
              <p className="text-white text-[11px] font-semibold line-clamp-1 mb-0.5">{titulo}</p>
              <div className="flex items-center gap-2">
                {episodeLabel && <span className="text-white/70 text-[9px]">{episodeLabel}</span>}
                {ano && <span className="text-zinc-300 text-[9px]">{ano}</span>}
                {nota && (
                  <span className="flex items-center gap-0.5 text-yellow-400 text-[9px]">
                    <Star size={7} fill="currentColor" /> {nota.toFixed(1)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Badges estáticos (desktop) */}
          {!hovered && (
            <>
              {episodeLabel && (
                <div className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-sm backdrop-blur-sm">
                  {episodeLabel}
                </div>
              )}
              {!episodeLabel && (urlDub || urlLeg) && (
                <div className="absolute top-1.5 left-1.5 flex gap-1">
                  {urlDub && <span className="bg-blue-600/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">DUB</span>}
                  {urlLeg && !urlDub && <span className="bg-zinc-700/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">LEG</span>}
                </div>
              )}
            </>
          )}

          {isNew && !progresso && (
            <div className="absolute bottom-0 left-0 right-0 bg-red-600 text-white text-[9px] font-semibold text-center py-[3px] tracking-wide">
              Recém Adicionado
            </div>
          )}
          {pct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/20">
              <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>

        {/* ── MOBILE: poster 2:3 vertical (como app Netflix mobile) ── */}
        <div className="md:hidden relative aspect-[2/3] rounded overflow-hidden bg-zinc-900 transition-transform duration-200 active:scale-95 shadow-md">
          <Image
            src={posterSrc}
            alt={titulo}
            fill
            className="object-cover"
            sizes="128px"
          />
          {urlDub && (
            <div className="absolute top-1 left-1 bg-blue-600 text-white text-[7px] font-bold px-1 py-0.5 rounded-sm">DUB</div>
          )}
          {isNew && !progresso && (
            <div className="absolute bottom-0 left-0 right-0 bg-red-600 text-white text-[8px] font-semibold text-center py-[2px]">
              Novo
            </div>
          )}
          {pct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/20">
              <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </Link>

      {/* Título — sempre visível em mobile (poster nem sempre tem texto legível) */}
      {/* Desktop: oculto pois o backdrop já tem o título embutido na imagem */}
      <p className="md:hidden text-zinc-300 text-[10px] font-medium mt-1 truncate leading-tight px-0.5">
        {titulo}
      </p>
    </div>
  );
}
