"use client";

import Link from "next/link";
import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { LandscapeCard } from "./LandscapeCard";

interface Item {
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

interface Props {
  titulo: string;
  items: Item[];
  verTodosHref?: string;
}

export function LandscapeRow({ titulo, items, verTodosHref }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: "left" | "right") =>
    ref.current?.scrollBy({ left: dir === "left" ? -700 : 700, behavior: "smooth" });

  if (!items.length) return null;

  return (
    <section className="mb-2 md:mb-4">
      {/* Section header — same left padding as hero content */}
      <div className="flex items-center gap-3 mb-2 px-4 md:px-14">
        <h2 className="text-white font-semibold text-sm md:text-[15px] tracking-wide">{titulo}</h2>
        {verTodosHref && (
          <Link
            href={verTodosHref}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors flex-none"
          >
            Ver todos →
          </Link>
        )}
      </div>

      <div className="relative group/row">
        {/* Left arrow */}
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-0 bottom-4 z-10 w-12 md:w-14 bg-gradient-to-r from-zinc-950 to-transparent text-white opacity-0 group-hover/row:opacity-100 transition-opacity flex items-center justify-center"
          aria-label="Anterior"
        >
          <ChevronLeft size={22} />
        </button>

        {/* Scroll container — same left padding as hero */}
        <div
          ref={ref}
          className="flex gap-1.5 md:gap-2 overflow-x-auto scrollbar-hide px-4 md:px-14 pb-1 scroll-smooth"
        >
          {items.map((item) => (
            <LandscapeCard key={item.id} {...item} />
          ))}
        </div>

        {/* Right arrow */}
        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 bottom-4 z-10 w-12 md:w-14 bg-gradient-to-l from-zinc-950 to-transparent text-white opacity-0 group-hover/row:opacity-100 transition-opacity flex items-center justify-center"
          aria-label="Próximo"
        >
          <ChevronRight size={22} />
        </button>
      </div>
    </section>
  );
}
