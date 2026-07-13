"use client";

import { useEffect, useState, useRef } from "react";
import { ChevronRight, X, Play } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { imgUrl } from "@/lib/tmdb";

interface HistoryItem {
  historyId: string;
  id: string;
  tipo: string;
  titulo: string;
  poster: string | null;
  background?: string | null;
  ano: number | null;
  nota: number | null;
  progressoSeg: number;
  duracaoSeg: number | null;
  temporada: number | null;
  numeroEp: number | null;
  episodioId: string | null;
  queued: boolean;
}

function pct(item: HistoryItem) {
  if (!item.duracaoSeg || item.duracaoSeg === 0) return 0;
  return Math.min(100, (item.progressoSeg / item.duracaoSeg) * 100);
}

function remainingMin(item: HistoryItem) {
  if (!item.duracaoSeg || item.duracaoSeg <= 0) return null;
  const rem = item.duracaoSeg - item.progressoSeg;
  if (rem <= 0) return null;
  return Math.ceil(rem / 60);
}

function watchUrl(item: HistoryItem) {
  if (item.tipo === "filme") return `/assistir/filme/${item.id}`;
  if (item.temporada && item.numeroEp)
    return `/assistir/serie/${item.id}/t${item.temporada}/ep${item.numeroEp}`;
  return `/serie/${item.id}`;
}

function episodeLabel(item: HistoryItem) {
  if (item.temporada && item.numeroEp)
    return `T${item.temporada} E${item.numeroEp}`;
  return null;
}

export function ContinuarAssistindo() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/continuar-assistindo")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setItems(data); })
      .finally(() => setLoaded(true));
  }, []);

  const remove = async (historyId: string) => {
    setItems((prev) => prev.filter((i) => i.historyId !== historyId));
    await fetch("/api/continuar-assistindo", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ historyId }),
    });
  };

  const scroll = (dir: "left" | "right") => {
    rowRef.current?.scrollBy({ left: dir === "left" ? -800 : 800, behavior: "smooth" });
  };

  if (!loaded || items.length === 0) return null;

  return (
    <section className="relative px-6 md:px-12 py-3 group/row">
      <h2 className="text-lg md:text-xl font-bold mb-3">Continuar Assistindo</h2>

      <div className="relative -mx-6 md:-mx-12">
        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 bottom-0 z-20 w-12 md:w-16 flex items-center justify-center bg-gradient-to-l from-black to-transparent opacity-0 group-hover/row:opacity-100 transition-opacity"
          aria-label="Próximo"
        >
          <ChevronRight className="w-7 h-7" />
        </button>

        <div
          ref={rowRef}
          className="flex gap-3 overflow-x-auto scrollbar-hide px-6 md:px-12 scroll-smooth"
        >
          {items.map((item) => {
            const imgSrc = item.background
              ? imgUrl(item.background, "w780")
              : item.poster
              ? imgUrl(item.poster, "w342")
              : "/placeholder-bg.jpg";

            const p = item.queued && item.progressoSeg === 0 ? 0 : pct(item);
            const rem = remainingMin(item);
            const ep = episodeLabel(item);

            return (
              <div
                key={item.historyId}
                className="group/card relative shrink-0 w-[220px] md:w-[280px]"
              >
                {/* Card thumbnail */}
                <Link
                  href={watchUrl(item)}
                  className="block relative aspect-video rounded-xl overflow-hidden bg-zinc-900 cursor-pointer"
                >
                  <Image
                    src={imgSrc}
                    alt={item.titulo}
                    fill
                    className="object-cover transition-transform duration-300 group-hover/card:scale-105"
                    sizes="(max-width: 768px) 220px, 280px"
                  />

                  {/* Permanent bottom gradient */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />

                  {/* Play button on hover */}
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 bg-black/30">
                    <div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center">
                      <Play size={20} fill="black" className="text-black ml-0.5" />
                    </div>
                  </div>

                  {/* Episode badge */}
                  {ep && (
                    <div className="absolute top-2 left-2 bg-black/70 text-white text-[10px] font-bold px-2 py-0.5 rounded backdrop-blur">
                      {ep}
                    </div>
                  )}

                  {/* PRÓXIMO badge */}
                  {item.queued && item.progressoSeg === 0 && (
                    <span className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider text-yellow-300 bg-yellow-500/20 backdrop-blur">
                      PRÓXIMO
                    </span>
                  )}

                  {/* Time remaining */}
                  {rem && (
                    <p className="absolute bottom-4 right-2 text-[10px] font-medium text-white/70">
                      {rem}min restantes
                    </p>
                  )}

                  {/* Progress bar */}
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
                    <div className="h-full bg-red-500" style={{ width: `${p}%` }} />
                  </div>
                </Link>

                {/* Info row below */}
                <div className="mt-2 px-0.5 flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-gray-200 truncate group-hover/card:text-white transition-colors duration-200">
                    {item.titulo}
                  </p>
                  {p > 0 && (
                    <span className="text-[10px] text-zinc-500 flex-shrink-0">
                      {Math.round(p)}%
                    </span>
                  )}
                </div>

                {/* Remove button */}
                <button
                  onClick={() => remove(item.historyId)}
                  className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/80 text-white/70 hover:text-white hover:bg-black transition opacity-0 group-hover/card:opacity-100 flex items-center justify-center z-10"
                  title="Remover"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
