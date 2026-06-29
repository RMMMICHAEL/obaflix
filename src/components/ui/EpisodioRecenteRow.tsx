"use client";

import Image from "next/image";
import Link from "next/link";
import { Play, Star } from "lucide-react";
import { useState, useRef } from "react";
import { imgUrl } from "@/lib/tmdb";

export interface EpisodioRecenteItem {
  episodioId: string;
  serieId: string;
  titulo: string | null;      // título do episódio
  serieTitulo: string;
  poster: string | null;
  thumbnail: string | null;
  temporada: number;
  numeroEp: number;
  tipo: "serie" | "anime" | "desenho";
  isNovoEpisodio: boolean;    // adicionado nas últimas 48h
  urlDub: string | null;
  urlLeg: string | null;
}

interface Props {
  titulo: string;
  items: EpisodioRecenteItem[];
}

function EpisodioCard({ item }: { item: EpisodioRecenteItem }) {
  const [hovered, setHovered] = useState(false);
  const href = `/assistir/serie/${item.serieId}/${item.temporada}/${item.numeroEp}`;
  const serieHref = `/serie/${item.serieId}`;

  const imgSrc = item.thumbnail
    ? imgUrl(item.thumbnail, "w300")
    : item.poster
    ? imgUrl(item.poster, "w342")
    : "/placeholder.jpg";

  const epLabel = `T${item.temporada} E${item.numeroEp}`;

  return (
    <div
      className="flex-none w-[168px] sm:w-[200px] md:w-[240px] group/card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Link href={href} className="block">
        {/* Thumbnail 16:9 */}
        <div className="relative aspect-video rounded-lg overflow-hidden bg-zinc-900 transition-transform duration-200 group-hover/card:scale-[1.03] active:scale-95 shadow-md group-hover/card:shadow-xl">
          <Image
            src={imgSrc}
            alt={item.serieTitulo}
            fill
            className={`object-cover transition-opacity duration-200 ${hovered ? "brightness-60" : ""}`}
            sizes="(max-width: 640px) 168px, (max-width: 768px) 200px, 240px"
          />

          {/* Badge temporada/ep */}
          <div className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-sm backdrop-blur-sm">
            {epLabel}
          </div>

          {/* DUB/LEG badge */}
          {!hovered && (
            <div className="absolute top-1.5 right-1.5 flex gap-1">
              {item.urlDub && <span className="bg-blue-600/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">DUB</span>}
              {item.urlLeg && !item.urlDub && <span className="bg-zinc-700/90 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">LEG</span>}
            </div>
          )}

          {/* Hover overlay */}
          <div className={`absolute inset-0 flex flex-col justify-between p-2 transition-opacity duration-150 ${hovered ? "opacity-100" : "opacity-0"}`}>
            <div className="flex gap-1">
              {item.urlDub && <span className="bg-blue-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">DUB</span>}
              {item.urlLeg && <span className="bg-zinc-600 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-sm">LEG</span>}
            </div>
            <div className="flex items-center justify-center">
              <div className="w-10 h-10 rounded-full bg-white/25 backdrop-blur-sm flex items-center justify-center border border-white/50">
                <Play size={16} fill="white" className="text-white ml-0.5" />
              </div>
            </div>
            <p className="text-white text-[10px] font-semibold line-clamp-2">
              {item.titulo || item.serieTitulo}
            </p>
          </div>

          {/* Novo Episódio badge */}
          {item.isNovoEpisodio && (
            <div className="absolute bottom-0 left-0 right-0 bg-red-600 text-white text-[9px] font-bold text-center py-[3px] tracking-wide uppercase">
              Novo Episódio
            </div>
          )}
        </div>
      </Link>

      {/* Info abaixo */}
      <Link href={serieHref} className="block mt-1 px-0.5 group/title">
        <p className="text-zinc-300 text-[11px] font-semibold truncate group-hover/title:text-white transition-colors">
          {item.serieTitulo}
        </p>
        <p className="text-zinc-500 text-[9px] mt-0.5">
          {epLabel}{item.titulo ? ` · ${item.titulo}` : ""}
        </p>
      </Link>
    </div>
  );
}

export function EpisodioRecenteRow({ titulo, items }: Props) {
  const rowRef = useRef<HTMLDivElement>(null);

  if (items.length === 0) return null;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between px-4 md:px-8 mb-3">
        <h2 className="text-white font-bold text-base md:text-lg tracking-tight">{titulo}</h2>
      </div>
      <div
        ref={rowRef}
        className="flex gap-3 overflow-x-auto px-4 md:px-8 pb-2 scrollbar-hide"
      >
        {items.map((item) => (
          <EpisodioCard key={item.episodioId} item={item} />
        ))}
      </div>
    </section>
  );
}
