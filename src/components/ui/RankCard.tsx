"use client";

import Image from "next/image";
import Link from "next/link";
import { imgUrl } from "@/lib/tmdb";

function imgFallback(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.currentTarget as HTMLImageElement).src = "/placeholder.jpg";
}

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

const CARD_H = 220;
const POSTER_W = 160;

export function RankCard({ rank, id, tipo, titulo, poster, urlDub, urlLeg, isNew }: Props) {
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;
  const is10plus = rank >= 10;

  // Para 1-9: área do número 140px, poster margem -20px → card total ~280px visível
  // Para 10+:  área do número 280px, número desloca -60px, poster margem -80px
  const numAreaW = is10plus ? 280 : 140;
  const numLeft = is10plus ? "-60px" : "0px";
  const numLetterSpacing = is10plus ? "6px" : "normal";
  const posterML = is10plus ? -80 : -20;
  const cardW = numAreaW + POSTER_W + posterML; // total visible width

  return (
    <Link
      href={href}
      title={titulo}
      className="flex-none cursor-pointer transition-all duration-300 group/card"
      style={{ width: `${cardW}px`, height: `${CARD_H}px`, minWidth: `${cardW}px` }}
    >
      <div className="relative flex items-start overflow-hidden" style={{ height: `${CARD_H}px` }}>

        {/* Número gigante — fica atrás do poster (z-10) */}
        <div className="relative z-10" style={{ width: `${numAreaW}px`, height: `${CARD_H}px`, flexShrink: 0 }}>
          <div
            className="absolute font-black leading-none select-none"
            style={{
              fontSize: "280px",
              fontFamily: "var(--font-bebas), 'Bebas Neue', Impact, Arial Black, sans-serif",
              marginTop: "25px",
              marginLeft: "40px",
              color: "rgb(0,0,0)",
              WebkitTextStroke: "4px rgb(85,85,85)",
              textShadow: "rgba(32,31,31,0.8) 0px 0px 30px",
              filter: "drop-shadow(rgba(0,0,0,0.9) 4px 4px 10px)",
              lineHeight: 0.7,
              top: 0,
              left: numLeft,
              transform: "translateY(-1px)",
              letterSpacing: numLetterSpacing,
            }}
          >
            {rank}
          </div>
        </div>

        {/* Poster — sobrepõe o número (z-20) */}
        <div
          className="relative overflow-hidden rounded-md bg-zinc-800 z-20"
          style={{ width: `${POSTER_W}px`, height: `${CARD_H}px`, marginLeft: `${posterML}px`, flexShrink: 0 }}
        >
          <Image
            src={poster ? imgUrl(poster, "w342") : "/placeholder.jpg"}
            alt={titulo}
            fill
            className="object-cover transition-opacity duration-300 group-hover/card:brightness-75"
            sizes={`${POSTER_W}px`}
            onError={imgFallback}
          />

          {urlDub && (
            <span className="absolute top-1.5 left-1.5 bg-blue-600 text-[8px] font-bold text-white px-1.5 py-0.5 rounded-sm z-10 leading-none">
              DUB
            </span>
          )}
          {urlLeg && !urlDub && (
            <span className="absolute top-1.5 left-1.5 bg-zinc-700 text-[8px] font-bold text-white px-1.5 py-0.5 rounded-sm z-10 leading-none">
              LEG
            </span>
          )}
          {isNew && (
            <div className="absolute bottom-0 left-0 right-0 bg-red-600 text-white text-[9px] font-semibold text-center py-[3px] z-10 tracking-wide">
              Recém Adicionado
            </div>
          )}
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition" />
        </div>

      </div>
    </Link>
  );
}
