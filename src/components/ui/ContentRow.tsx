"use client";

import Link from "next/link";
import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ContentCard } from "./ContentCard";

interface Item {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  ano: number | null;
  nota: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
}

interface Props {
  titulo: string;
  items: Item[];
  verTodosHref?: string;
}

export function ContentRow({ titulo, items, verTodosHref }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const scroll = (dir: "left" | "right") => {
    if (!ref.current) return;
    ref.current.scrollBy({ left: dir === "left" ? -800 : 800, behavior: "smooth" });
  };

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
        <div ref={ref} className="flex gap-3 overflow-x-auto scrollbar-hide px-4 md:px-8 pb-2 scroll-smooth">
          {items.map((item) => (
            <div key={item.id} className="flex-none w-36 md:w-44">
              <ContentCard {...item} />
            </div>
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
