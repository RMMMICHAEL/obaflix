"use client";

import Image from "next/image";
import Link from "next/link";
import { imgUrl } from "@/lib/tmdb";

interface Props {
  rank: number;
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  isNew?: boolean;
}

export function RankCard({ rank, id, tipo, titulo, poster, urlDub, urlLeg, isNew }: Props) {
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;
  const POSTER_W = 80;
  const POSTER_H = 120;
  const CONT_W = 124;
  const fontSize = rank >= 10 ? "4.5rem" : "5.75rem";

  return (
    <div className="flex-none relative" style={{ width: `${CONT_W}px`, height: `${POSTER_H}px` }}>
      {/* Large rank number behind poster */}
      <span
        className="absolute left-0 bottom-0 select-none font-black pointer-events-none"
        style={{
          fontSize,
          color: "transparent",
          WebkitTextStroke: "2.5px #52525b",
          letterSpacing: "-0.05em",
          lineHeight: 1,
          zIndex: 0,
        }}
      >
        {rank}
      </span>

      {/* Poster */}
      <Link
        href={href}
        title={titulo}
        className="absolute right-0 bottom-0 rounded overflow-hidden group/card transition-transform duration-200 hover:scale-105"
        style={{ width: `${POSTER_W}px`, height: `${POSTER_H}px`, zIndex: 10 }}
      >
        <div className="relative w-full h-full bg-zinc-900">
          <Image
            src={poster ? imgUrl(poster, "w342") : "/placeholder.jpg"}
            alt={titulo}
            fill
            className="object-cover"
            sizes={`${POSTER_W}px`}
          />
          {urlDub && (
            <span className="absolute top-1 left-1 bg-blue-600 text-[8px] font-bold text-white px-1 py-0.5 rounded-sm leading-none z-10">
              DUB
            </span>
          )}
          {urlLeg && !urlDub && (
            <span className="absolute top-1 left-1 bg-zinc-700 text-[8px] font-bold text-white px-1 py-0.5 rounded-sm leading-none z-10">
              LEG
            </span>
          )}
          {/* "Recém Adicionado" badge — full-width bottom, como 1Flex */}
          {isNew && (
            <div className="absolute bottom-0 left-0 right-0 bg-red-600 text-white text-[8px] font-semibold text-center py-[3px] z-10 tracking-wide">
              Recém Adicionado
            </div>
          )}
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition" />
        </div>
      </Link>
    </div>
  );
}
