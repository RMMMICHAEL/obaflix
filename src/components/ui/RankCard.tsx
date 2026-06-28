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
}

export function RankCard({ rank, id, tipo, titulo, poster, urlDub, urlLeg }: Props) {
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;
  const POSTER_W = 78;
  const POSTER_H = 117;
  const CONT_W = 120;
  const fontSize = rank >= 10 ? "4.25rem" : "5.5rem";

  return (
    <div className="flex-none relative" style={{ width: `${CONT_W}px`, height: `${POSTER_H}px` }}>
      {/* Large rank number — sits behind the poster */}
      <span
        className="absolute left-0 bottom-0 select-none font-black leading-none pointer-events-none"
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

      {/* Poster — overlaps the right portion of the number */}
      <Link
        href={href}
        title={titulo}
        className="absolute right-0 bottom-0 rounded-lg overflow-hidden group/card transition-transform duration-200 hover:scale-105"
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
            <span className="absolute top-1 left-1 bg-blue-600 text-[8px] font-bold text-white px-1 py-0.5 rounded leading-none z-10">
              DUB
            </span>
          )}
          {urlLeg && !urlDub && (
            <span className="absolute top-1 left-1 bg-zinc-700 text-[8px] font-bold text-white px-1 py-0.5 rounded leading-none z-10">
              LEG
            </span>
          )}
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition" />
        </div>
      </Link>
    </div>
  );
}
