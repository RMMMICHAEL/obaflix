"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

export interface CollectionRailItem {
  id: number;
  nome: string;
  poster: string | null;
  backdrop: string | null;
  count: number;
}

export function CollectionRail({ cards }: { cards: CollectionRailItem[] }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const updateControls = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    setCanGoBack(rail.scrollLeft > 8);
    setCanGoForward(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 8);
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    updateControls();
    const observer = new ResizeObserver(updateControls);
    observer.observe(rail);
    rail.addEventListener("scroll", updateControls, { passive: true });
    return () => {
      observer.disconnect();
      rail.removeEventListener("scroll", updateControls);
    };
  }, [updateControls]);

  const move = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(320, rail.clientWidth * 0.82), behavior: "smooth" });
  };

  return (
    <div className="relative -mx-6 md:-mx-12">
      <button
        type="button"
        onClick={() => move(-1)}
        disabled={!canGoBack}
        aria-label="Ver coleções anteriores"
        className="absolute inset-y-0 left-0 z-20 hidden w-14 items-center justify-center bg-gradient-to-r from-zinc-950 via-zinc-950/80 to-transparent text-white transition-opacity duration-200 disabled:pointer-events-none disabled:opacity-0 md:flex"
      >
        <ChevronLeft className="h-7 w-7" />
      </button>

      <div
        ref={railRef}
        className="flex snap-x snap-proximity gap-3 overflow-x-auto px-6 pb-2 scrollbar-hide scroll-smooth md:px-12"
      >
        {cards.map((card) => (
          <Link
            key={card.id}
            href={`/colecao/${card.id}`}
            className="group/card w-[140px] shrink-0 snap-start sm:w-[160px] md:w-[200px]"
          >
            <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/[0.06]">
              <Image
                src={imgUrl(card.poster ?? card.backdrop, "w342")}
                alt={card.nome}
                fill
                className="object-cover transition-transform duration-200 ease-out group-hover/card:scale-[1.035]"
                sizes="(max-width: 640px) 140px, (max-width: 768px) 160px, 200px"
                loading="lazy"
              />
              <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-zinc-950/80 to-transparent" />
            </div>
            <p className="mt-2 truncate text-sm font-medium text-zinc-200 transition-colors group-hover/card:text-white">
              {card.nome}
            </p>
            {card.count > 0 && <p className="mt-0.5 text-[11px] text-zinc-500">{card.count} filmes</p>}
          </Link>
        ))}
      </div>

      <button
        type="button"
        onClick={() => move(1)}
        disabled={!canGoForward}
        aria-label="Ver mais coleções"
        className="absolute inset-y-0 right-0 z-20 hidden w-14 items-center justify-center bg-gradient-to-l from-zinc-950 via-zinc-950/80 to-transparent text-white transition-opacity duration-200 disabled:pointer-events-none disabled:opacity-0 md:flex"
      >
        <ChevronRight className="h-7 w-7" />
      </button>
    </div>
  );
}
