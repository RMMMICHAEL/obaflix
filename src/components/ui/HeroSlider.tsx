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
  trailerKey?: string | null;
}

const INTERVAL = 8000;
const TRAILER_DELAY = 2500;

export function HeroSlider({ items }: { items: HeroItem[] }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showTrailer, setShowTrailer] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const goTo = useCallback((i: number) => {
    setIdx(i);
    setProgress(0);
    setShowTrailer(false);
  }, []);

  const prev = useCallback(() => goTo((idx - 1 + items.length) % items.length), [idx, items.length, goTo]);
  const next = useCallback(() => goTo((idx + 1) % items.length), [idx, items.length, goTo]);

  // Progress bar + auto-advance
  useEffect(() => {
    setProgress(0);
    setShowTrailer(false);
    if (paused) return;
    const start = Date.now();
    const tick = setInterval(() => {
      const pct = ((Date.now() - start) / INTERVAL) * 100;
      if (pct >= 100) {
        setIdx((i) => (i + 1) % items.length);
        setProgress(0);
        setShowTrailer(false);
      } else {
        setProgress(pct);
      }
    }, 80);
    return () => clearInterval(tick);
  }, [idx, paused, items.length]);

  // Trailer auto-play on desktop after TRAILER_DELAY ms
  useEffect(() => {
    const item = items[idx];
    if (!item?.trailerKey || !isDesktop || paused) return;
    const timer = setTimeout(() => setShowTrailer(true), TRAILER_DELAY);
    return () => clearTimeout(timer);
  }, [idx, paused, isDesktop, items]);

  if (!items.length) return null;
  const item = items[idx];
  const href = item.tipo === "filme" ? `/filme/${item.id}` : `/serie/${item.id}`;
  const bgSrc = item.background
    ? item.background.startsWith("http") ? item.background : imgUrl(item.background, "w1280")
    : "/placeholder-bg.jpg";

  return (
    <div
      className="relative h-[55vh] md:h-[65vh] min-h-[340px] md:min-h-[420px] w-full overflow-hidden select-none"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Static backdrop */}
      <Image
        src={bgSrc}
        alt={item.titulo}
        fill
        sizes="100vw"
        className={`object-cover object-top transition-opacity duration-700 ${showTrailer ? "opacity-0" : "opacity-100"}`}
        priority
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = "/placeholder-bg.jpg"; }}
      />

      {/* YouTube trailer (desktop only, after delay) */}
      {showTrailer && item.trailerKey && (
        <div className="absolute inset-0 overflow-hidden animate-fadeIn">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${item.trailerKey}?autoplay=1&mute=1&controls=0&loop=1&playlist=${item.trailerKey}&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1`}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{ width: "177.78vh", height: "100vh", minWidth: "100%", minHeight: "56.25vw", border: "none" }}
            allow="autoplay; encrypted-media"
            title={item.titulo}
          />
        </div>
      )}

      {/* Gradient — matches 1Flex exactly */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent z-10 pointer-events-none" />

      {/* Prev / Next arrows */}
      <button
        onClick={prev}
        aria-label="Anterior"
        className="absolute left-2 md:left-4 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center hover:bg-black/70 transition opacity-50 hover:opacity-100"
      >
        <ChevronLeft size={18} />
      </button>
      <button
        onClick={next}
        aria-label="Próximo"
        className="absolute right-2 md:right-4 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center hover:bg-black/70 transition opacity-50 hover:opacity-100"
      >
        <ChevronRight size={18} />
      </button>

      {/* Content */}
      <div className="absolute bottom-12 md:bottom-16 left-4 md:left-14 max-w-lg z-20">
        <h1
          className="text-white font-black text-3xl md:text-5xl lg:text-6xl mb-3 md:mb-4 leading-tight line-clamp-2"
          style={{ textShadow: "2px 2px 12px rgba(0,0,0,0.8), 0 0 40px rgba(0,0,0,0.6)" }}
        >
          {item.titulo}
        </h1>
        {item.sinopse && (
          <p
            className="text-zinc-100 text-sm md:text-base line-clamp-3 mb-5 max-w-md leading-relaxed"
            style={{ textShadow: "1px 1px 6px rgba(0,0,0,0.9)" }}
          >
            {item.sinopse}
          </p>
        )}
        <div className="flex gap-3 flex-wrap">
          {/* Play — white bg, black text, square como 1Flex */}
          <Link
            href={href}
            className="flex items-center gap-2 bg-white text-black font-bold px-6 py-2.5 rounded text-sm shadow-lg hover:bg-zinc-100 transition-colors"
          >
            <Play size={16} fill="black" /> Assistir
          </Link>
          {/* More Info — dark semi-transparent, como 1Flex */}
          <Link
            href={href}
            className="flex items-center gap-2 bg-zinc-800/80 text-white font-semibold px-6 py-2.5 rounded text-sm hover:bg-zinc-700 transition-colors border border-zinc-700/50"
          >
            <Info size={16} /> Mais Info
          </Link>
        </div>
      </div>

      {/* Indicator dots */}
      <div className="absolute bottom-5 left-4 md:left-14 flex gap-1.5 z-20">
        {items.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Slide ${i + 1}`}
            className={`rounded-full transition-all duration-300 ${
              i === idx ? "bg-white w-5 h-1" : "bg-zinc-600 w-1.5 h-1"
            }`}
          />
        ))}
      </div>

      {/* Progress bar at very bottom */}
      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-zinc-800/80 z-20">
        <div
          className="h-full bg-red-600"
          style={{ width: `${progress}%`, transition: "width 80ms linear" }}
        />
      </div>
    </div>
  );
}
