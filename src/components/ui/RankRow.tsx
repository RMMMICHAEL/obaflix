"use client";

import Link from "next/link";
import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { RankCard } from "./RankCard";

interface Item {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  isNew?: boolean;
}

interface Props {
  titulo: string;
  items: Item[];
  verTodosHref?: string;
}

export function RankRow({ titulo, items, verTodosHref }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: "left" | "right") =>
    ref.current?.scrollBy({ left: dir === "left" ? -600 : 600, behavior: "smooth" });

  if (!items.length) return null;

  return (
    <section className="mb-2 md:mb-6">
      <div className="flex items-center gap-3 mb-2 px-4 md:px-14">
        <h2 className="text-white font-semibold text-sm md:text-[15px] tracking-wide">{titulo}</h2>
        {verTodosHref && (
          <Link href={verTodosHref} className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors flex-none">
            Ver todos →
          </Link>
        )}
      </div>

      <div className="relative group/row">
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-0 bottom-0 z-10 w-12 md:w-14 bg-gradient-to-r from-zinc-950 to-transparent text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronLeft size={22} />
        </button>

        <div
          ref={ref}
          className="flex gap-2 overflow-x-auto scrollbar-hide px-4 md:px-14 pb-4 pt-1 scroll-smooth"
        >
          {items.slice(0, 10).map((item, i) => (
            <RankCard key={item.id} rank={i + 1} isNew={item.isNew} {...item} />
          ))}
        </div>

        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 bottom-0 z-10 w-12 md:w-14 bg-gradient-to-l from-zinc-950 to-transparent text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronRight size={24} />
        </button>
      </div>
    </section>
  );
}
