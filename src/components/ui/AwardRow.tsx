"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Trophy } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

export interface AwardRowItem {
  id: string;
  tipo: "filme" | "serie";
  titulo: string;
  poster: string | null;
  background?: string | null;
  ano: number | null;
  count: number;
}

type Props = {
  title: string;
  description: string;
  unit: "Oscar" | "Emmy";
  items: AwardRowItem[];
};

export function AwardRow({ title, description, unit, items }: Props) {
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

  if (!items.length) return null;
  const isOscar = unit === "Oscar";
  const accent = isOscar ? "oklch(0.82 0.15 82)" : "oklch(0.72 0.14 285)";

  const move = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(320, rail.clientWidth * 0.82), behavior: "smooth" });
  };

  return (
    <section className="relative py-5">
      <div className="mb-3 px-6 md:px-12">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4" style={{ color: accent }} aria-hidden="true" />
          <h2 className="text-lg font-bold text-zinc-100 md:text-xl">{title}</h2>
        </div>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500 md:text-sm">{description}</p>
      </div>

      <div className="relative group/awards">
        <button
          type="button"
          onClick={() => move(-1)}
          disabled={!canGoBack}
          aria-label="Ver títulos anteriores"
          className="absolute inset-y-0 left-0 z-20 hidden w-14 items-center justify-center bg-gradient-to-r from-zinc-950 via-zinc-950/85 to-transparent text-white transition-opacity disabled:pointer-events-none disabled:opacity-0 md:flex"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>

        <div ref={railRef} className="flex snap-x snap-proximity gap-3 overflow-x-auto px-6 pb-3 scrollbar-hide scroll-smooth md:px-12">
          {items.map((item, index) => (
            <Link
              key={`${item.tipo}-${item.id}`}
              href={item.tipo === "filme" ? `/filme/${item.id}` : `/serie/${item.id}`}
              className="group/card w-[220px] shrink-0 snap-start sm:w-[250px] md:w-[280px]"
            >
              <div className="relative aspect-video overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-white/[0.07]">
                <Image
                  src={item.background ? imgUrl(item.background, "w780") : item.poster ? imgUrl(item.poster, "w342") : "/placeholder.jpg"}
                  alt={item.titulo}
                  fill
                  className="object-cover transition-transform duration-200 ease-out group-hover/card:scale-[1.035]"
                  sizes="(max-width: 640px) 220px, (max-width: 768px) 250px, 280px"
                />
                <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2">
                  <span className="grid h-7 min-w-7 place-items-center rounded-md bg-zinc-950/90 px-1.5 text-xs font-bold text-zinc-100 ring-1 ring-white/10">
                    {index + 1}
                  </span>
                  <span
                    className="rounded-md bg-zinc-950/90 px-2 py-1 text-[10px] font-bold ring-1 ring-white/10"
                    style={{ color: accent }}
                  >
                    {item.count} {unit}{item.count === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              <p className="mt-2 truncate text-sm font-medium text-zinc-200 group-hover/card:text-white">{item.titulo}</p>
              {item.ano && <p className="mt-0.5 text-[11px] text-zinc-500">{item.ano}</p>}
            </Link>
          ))}
        </div>

        <button
          type="button"
          onClick={() => move(1)}
          disabled={!canGoForward}
          aria-label="Ver mais títulos premiados"
          className="absolute inset-y-0 right-0 z-20 hidden w-14 items-center justify-center bg-gradient-to-l from-zinc-950 via-zinc-950/85 to-transparent text-white transition-opacity disabled:pointer-events-none disabled:opacity-0 md:flex"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>
    </section>
  );
}
