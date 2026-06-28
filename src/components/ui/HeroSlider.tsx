"use client";

import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { Play, Info, ChevronLeft, ChevronRight } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

interface HeroItem {
  id: string;
  tipo: string;
  titulo: string;
  sinopse: string | null;
  background: string | null;
}

const INTERVAL = 8000;

export function HeroSlider({ items }: { items: HeroItem[] }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);

  const goTo = useCallback((i: number) => {
    setIdx(i);
    setProgress(0);
  }, []);

  const prev = useCallback(() => goTo((idx - 1 + items.length) % items.length), [idx, items.length, goTo]);
  const next = useCallback(() => goTo((idx + 1) % items.length), [idx, items.length, goTo]);

  useEffect(() => {
    setProgress(0);
    if (paused) return;
    const start = Date.now();
    const tick = setInterval(() => {
      const pct = ((Date.now() - start) / INTERVAL) * 100;
      if (pct >= 100) {
        setIdx((i) => (i + 1) % items.length);
        setProgress(0);
      } else {
        setProgress(pct);
      }
    }, 80);
    return () => clearInterval(tick);
  }, [idx, paused, items.length]);

  if (!items.length) return null;
  const item = items[idx];
  const href = item.tipo === "filme" ? `/filme/${item.id}` : `/serie/${item.id}`;
  const bgSrc = item.background
    ? item.background.startsWith("http") ? item.background : imgUrl(item.background, "original")
    : "/placeholder-bg.jpg";

  return (
    <div
      className="relative h-[72vh] min-h-[440px] w-full overflow-hidden select-none"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Backdrop */}
      <Image src={bgSrc} alt={item.titulo} fill className="object-cover transition-opacity duration-700" priority />

      {/* Gradients */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/95 via-black/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/10 to-transparent" />

      {/* Prev arrow */}
      <button
        onClick={prev}
        aria-label="Anterior"
        className="absolute left-2 md:left-4 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/80 transition opacity-60 hover:opacity-100"
      >
        <ChevronLeft size={20} />
      </button>

      {/* Next arrow */}
      <button
        onClick={next}
        aria-label="Próximo"
        className="absolute right-2 md:right-4 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/80 transition opacity-60 hover:opacity-100"
      >
        <ChevronRight size={20} />
      </button>

      {/* Content */}
      <div className="absolute bottom-20 left-4 md:left-16 max-w-lg z-10">
        <h1 className="text-white font-black text-3xl md:text-5xl mb-3 drop-shadow-xl leading-tight">
          {item.titulo}
        </h1>
        {item.sinopse && (
          <p className="text-zinc-300 text-sm md:text-base line-clamp-3 mb-5 max-w-md leading-relaxed">
            {item.sinopse}
          </p>
        )}
        <div className="flex gap-3 flex-wrap">
          <Link
            href={href}
            className="flex items-center gap-2 bg-white text-black font-bold px-6 py-2.5 rounded-lg hover:bg-zinc-100 transition text-sm shadow-lg"
          >
            <Play size={16} fill="black" /> Assistir
          </Link>
          <Link
            href={href}
            className="flex items-center gap-2 bg-white/10 backdrop-blur border border-white/20 text-white font-semibold px-6 py-2.5 rounded-lg hover:bg-white/20 transition text-sm"
          >
            <Info size={16} /> Mais Info
          </Link>
        </div>
      </div>

      {/* Dots */}
      <div className="absolute bottom-8 left-4 md:left-16 flex gap-1.5 z-10">
        {items.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Slide ${i + 1}`}
            className={`rounded-full transition-all duration-300 ${
              i === idx ? "bg-white w-5 h-1.5" : "bg-zinc-500 w-1.5 h-1.5"
            }`}
          />
        ))}
      </div>

      {/* Progress bar */}
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-zinc-800 z-10">
        <div
          className="h-full bg-red-600"
          style={{ width: `${progress}%`, transition: "width 80ms linear" }}
        />
      </div>
    </div>
  );
}
