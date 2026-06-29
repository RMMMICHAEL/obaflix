"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Play, Star } from "lucide-react";
import { imgUrl, logoUrl } from "@/lib/tmdb";

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
  const [hovered, setHovered] = useState(false);
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;

  const imgSrc = background
    ? imgUrl(background, "w780")
    : poster
    ? imgUrl(poster, "w342")
    : "/placeholder-bg.jpg";

  const logoSrc = logoUrl(logo);

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
        <div className="relative aspect-video rounded overflow-hidden bg-zinc-900 transition-transform duration-200 group-hover/card:scale-[1.04] group-hover/card:z-10 shadow-md group-hover/card:shadow-xl">
          {/* Backdrop */}
          <Image
            src={imgSrc}
            alt={titulo}
            fill
            className={`object-cover transition-opacity duration-200 ${hovered ? "brightness-75" : "brightness-100"}`}
            sizes="(max-width: 640px) 160px, (max-width: 768px) 176px, 224px"
          />

          {/* Logo TMDB — sempre visível no bottom-left do card */}
          {logoSrc && (
            <div className="absolute bottom-2 left-2 right-2 flex items-end pointer-events-none">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logoSrc}
                alt={titulo}
                className="max-h-8 md:max-h-10 max-w-[80%] object-contain object-left drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]"
                style={{ filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.9))" }}
              />
            </div>
          )}

          {/* Hover overlay */}
          <div
            className={`absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent flex flex-col justify-between p-2 transition-opacity duration-150 ${
              hovered ? "opacity-100" : "opacity-0"
            }`}
          >
            {/* Top: badges DUB/LEG */}
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
              <div className="w-9 h-9 rounded-full bg-white/25 backdrop-blur-sm flex items-center justify-center border border-white/50 transition">
                <Play size={14} fill="white" className="text-white ml-0.5" />
              </div>
            </div>

            {/* Bottom: título (texto) + meta */}
            <div>
              <p className="text-white text-[11px] font-semibold line-clamp-1 mb-0.5 drop-shadow">{titulo}</p>
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

          {/* Badge episódio (estático, some no hover) */}
          {episodeLabel && !hovered && (
            <div className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-sm backdrop-blur-sm">
              {episodeLabel}
            </div>
          )}

          {/* DUB/LEG estático sem episodeLabel */}
          {!hovered && !episodeLabel && (urlDub || urlLeg) && (
            <div className="absolute top-1.5 left-1.5 flex gap-1">
              {urlDub && <span className="bg-blue-600/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">DUB</span>}
              {urlLeg && !urlDub && <span className="bg-zinc-700/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">LEG</span>}
            </div>
          )}

          {/* Badge "Recém Adicionado" — full-width centrado no bottom, igual 1Flex */}
          {isNew && !progresso && (
            <div className="absolute bottom-0 left-0 right-0 bg-red-600 text-white text-[9px] font-semibold text-center py-[3px] tracking-wide">
              Recém Adicionado
            </div>
          )}

          {/* Barra de progresso */}
          {pct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/20">
              <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </Link>

      {/* Título em texto — visível SEMPRE quando não tem logo, e em mobile sempre */}
      {!logoSrc && (
        <p className="text-zinc-300 text-[11px] font-medium mt-1.5 truncate leading-tight px-0.5">
          {titulo}
        </p>
      )}
      {logoSrc && (
        <p className="md:hidden text-zinc-300 text-[11px] font-medium mt-1 truncate leading-tight px-0.5">
          {titulo}
        </p>
      )}
    </div>
  );
}
