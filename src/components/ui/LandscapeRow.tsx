"use client";

import Link from "next/link";
import { useRef } from "react";
import { ChevronRight } from "lucide-react";
import { LandscapeCard } from "./LandscapeCard";

interface Item {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  background?: string | null;
  /** Arte ja traz o titulo desenhado em portugues: o rotulo abaixo some. */
  backgroundTituloPt?: boolean | null;
  logo?: string | null;
  ano?: number | null;
  nota?: number | null;
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
    ref.current?.scrollBy({ left: dir === "left" ? -800 : 800, behavior: "smooth" });

  if (!items.length) return null;

  // O card agora carrega o nome embaixo, entao a propria fileira ficou mais
  // alta e o respiro anterior (pt-10/pb-6) virou vazio entre as secoes. Menos
  // padding aqui equilibra sem colar uma fileira na outra.
  return (
    <section className="relative px-4 md:px-14 pt-5 pb-2 md:pt-7 md:pb-3 group/row">
      <h2 className="text-white font-semibold text-base md:text-lg tracking-tight mb-3 flex items-center gap-3">
        {titulo}
        {verTodosHref && (
          <Link
            href={verTodosHref}
            className="text-xs font-normal text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Ver todos →
          </Link>
        )}
      </h2>

      <div className="relative -mx-4 md:-mx-14">
        {/* Right fade + arrow */}
        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 bottom-0 z-20 w-12 md:w-16 flex items-center justify-center bg-gradient-to-l from-black to-transparent opacity-0 group-hover/row:opacity-100 transition-opacity"
          aria-label="Próximo"
        >
          <ChevronRight className="w-7 h-7" />
        </button>

        <div
          ref={ref}
          className="flex gap-2 md:gap-3 overflow-x-auto scrollbar-hide px-4 md:px-14 scroll-smooth"
        >
          {items.map((item) => (
            <LandscapeCard key={item.id} {...item} />
          ))}
        </div>
      </div>
    </section>
  );
}
