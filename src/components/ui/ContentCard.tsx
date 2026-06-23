"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Heart, Play, Star } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

interface Props {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  ano: number | null;
  nota: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  progresso?: { progressoSeg: number; duracaoSeg: number | null } | null;
  onWatchlistToggle?: (id: string, tipo: string) => void;
  inWatchlist?: boolean;
}

export function ContentCard({ id, tipo, titulo, poster, ano, nota, urlDub, urlLeg, progresso, onWatchlistToggle, inWatchlist }: Props) {
  const [hovered, setHovered] = useState(false);
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;
  const playerHref = tipo === "filme" ? `/assistir/filme/${id}` : `/serie/${id}`;
  const pct = progresso?.duracaoSeg ? (progresso.progressoSeg / progresso.duracaoSeg) * 100 : 0;

  return (
    <div
      className="relative group rounded-lg overflow-hidden bg-zinc-900 cursor-pointer transition-transform duration-200 hover:scale-105 hover:z-10"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link href={href}>
        <div className="aspect-[2/3] relative">
          <Image
            src={poster ? imgUrl(poster, "w342") : "/placeholder.jpg"}
            alt={titulo}
            fill
            className="object-cover"
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
          />
          {/* badges */}
          <div className="absolute top-2 left-2 flex gap-1">
            {urlDub && <span className="bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">DUB</span>}
            {urlLeg && <span className="bg-zinc-700 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">LEG</span>}
          </div>
          {/* progress bar */}
          {pct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-700">
              <div className="h-full bg-red-600" style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
          )}
        </div>
      </Link>

      {/* hover overlay */}
      {hovered && (
        <div className="absolute inset-0 bg-black/80 flex flex-col justify-between p-3 transition-opacity">
          <div>
            <p className="text-white font-semibold text-sm line-clamp-2">{titulo}</p>
            <div className="flex items-center gap-2 mt-1 text-xs text-zinc-400">
              {ano && <span>{ano}</span>}
              {nota && (
                <span className="flex items-center gap-0.5 text-yellow-400">
                  <Star size={10} fill="currentColor" /> {nota.toFixed(1)}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Link
              href={playerHref}
              className="flex-1 flex items-center justify-center gap-1 bg-white text-black text-xs font-bold py-1.5 rounded hover:bg-zinc-200 transition"
            >
              <Play size={12} fill="black" /> Assistir
            </Link>
            {onWatchlistToggle && (
              <button
                onClick={(e) => { e.preventDefault(); onWatchlistToggle(id, tipo); }}
                className={`p-1.5 rounded border transition ${inWatchlist ? "border-red-500 text-red-500" : "border-zinc-500 text-zinc-400 hover:border-white hover:text-white"}`}
              >
                <Heart size={14} fill={inWatchlist ? "currentColor" : "none"} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
