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
    <section className="mb-8">
      <div className="flex items-center gap-3 mb-3 px-4 md:px-8">
        <h2 className="text-white font-semibold text-lg">{titulo}</h2>
        {verTodosHref && (
          <Link href={verTodosHref} className="text-xs text-zinc-400 hover:text-white transition ml-1">
            Ver todos →
          </Link>
        )}
      </div>

      <div className="relative group/row">
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-0 bottom-0 z-10 w-10 bg-black/60 text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronLeft size={24} />
        </button>

        <div
          ref={ref}
          className="flex gap-2 overflow-x-auto scrollbar-hide px-4 md:px-8 pb-4 pt-2 scroll-smooth"
        >
          {items.slice(0, 10).map((item, i) => (
            <RankCard key={item.id} rank={i + 1} {...item} />
          ))}
        </div>

        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 bottom-0 z-10 w-10 bg-black/60 text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronRight size={24} />
        </button>
      </div>
    </section>
  );
}
