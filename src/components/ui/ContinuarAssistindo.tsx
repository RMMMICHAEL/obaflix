"use client";

import { useEffect, useState, useRef } from "react";
import { ChevronLeft, ChevronRight, X, Play } from "lucide-react";
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

function watchUrl(item: HistoryItem) {
  if (item.tipo === "filme") return `/assistir/filme/${item.id}`;
  if (item.temporada && item.numeroEp)
    return `/assistir/serie/${item.id}/t${item.temporada}/ep${item.numeroEp}`;
  return `/serie/${item.id}`;
}

function episodeLabel(item: HistoryItem) {
  if (item.temporada && item.numeroEp) return `T${item.temporada} E${item.numeroEp}`;
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
    rowRef.current?.scrollBy({ left: dir === "left" ? -700 : 700, behavior: "smooth" });
  };

  if (!loaded || items.length === 0) return null;

  return (
    <section className="mb-2 md:mb-4">
      <h2 className="text-white font-semibold text-sm md:text-[15px] tracking-wide mb-2 px-4 md:px-14">
        Continuar Assistindo
      </h2>
      <div className="relative group/row">
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-0 bottom-0 z-10 w-12 md:w-14 bg-gradient-to-r from-zinc-950 to-transparent text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronLeft size={22} />
        </button>

        <div ref={rowRef} className="flex gap-1.5 md:gap-2 overflow-x-auto scrollbar-hide px-4 md:px-14 pb-1 scroll-smooth">
          {items.map((item) => {
            const imgSrc = item.background
              ? imgUrl(item.background, "w780")
              : item.poster
              ? imgUrl(item.poster, "w342")
              : "/placeholder-bg.jpg";

            const p = item.queued && item.progressoSeg === 0 ? 0 : pct(item);
            const ep = episodeLabel(item);

            return (
              <div key={item.historyId} className="flex-none w-36 sm:w-40 md:w-56 relative group/card">
                {/* Card */}
                <Link
                  href={watchUrl(item)}
                  className="block relative aspect-video rounded overflow-hidden bg-zinc-900 shadow-md transition-transform duration-200 group-hover/card:scale-[1.04] group-hover/card:z-10"
                >
                  <Image
                    src={imgSrc}
                    alt={item.titulo}
                    fill
                    className="object-cover"
                    sizes="(max-width: 640px) 176px, (max-width: 768px) 192px, 224px"
                  />

                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-black/20 opacity-0 group-hover/card:opacity-100 transition-opacity duration-150 flex flex-col justify-between p-2">
                    <div />
                    <div className="flex items-center justify-center">
                      <div className="w-8 h-8 rounded-full bg-white/25 backdrop-blur-sm flex items-center justify-center border border-white/40">
                        <Play size={13} fill="white" className="text-white ml-0.5" />
                      </div>
                    </div>
                    <div>
                      <p className="text-white text-[11px] font-semibold line-clamp-1 mb-0.5">{item.titulo}</p>
                      {ep && <p className="text-white/60 text-[9px]">{ep}</p>}
                    </div>
                  </div>

                  {/* Episode badge (static, hides on hover) */}
                  {ep && (
                    <div className="group-hover/card:opacity-0 transition-opacity absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-sm">
                      {ep}
                    </div>
                  )}

                  {/* PRÓXIMO badge */}
                  {item.queued && item.progressoSeg === 0 && (
                    <div className="absolute bottom-0 left-0 bg-red-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-tr-sm">
                      PRÓXIMO
                    </div>
                  )}

                  {/* Progress bar */}
                  <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/20">
                    <div className="h-full bg-red-500" style={{ width: `${p}%` }} />
                  </div>
                </Link>

                {/* Remove button */}
                <button
                  onClick={() => remove(item.historyId)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/80 text-white/70 hover:text-white hover:bg-black transition opacity-0 group-hover/card:opacity-100 flex items-center justify-center z-10"
                  title="Remover"
                >
                  <X size={10} />
                </button>

                {/* Title: mobile only */}
                <p className="md:hidden text-zinc-400 text-[11px] font-medium mt-1 truncate leading-tight px-0.5">
                  {item.titulo}
                </p>
              </div>
            );
          })}
        </div>

        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 bottom-0 z-10 w-12 md:w-14 bg-gradient-to-l from-zinc-950 to-transparent text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronRight size={20} />
        </button>
      </div>
    </section>
  );
}
