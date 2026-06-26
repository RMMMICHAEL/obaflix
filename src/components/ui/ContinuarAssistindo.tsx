"use client";

import { useEffect, useState, useRef } from "react";
import { ChevronLeft, ChevronRight, X, Play } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

interface HistoryItem {
  historyId: string;
  id: string;
  tipo: string;
  titulo: string;
  poster: string | null;
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

function label(item: HistoryItem) {
  if (item.temporada && item.numeroEp) return `T${item.temporada} EP${item.numeroEp}`;
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
    <section className="mb-8">
      <h2 className="text-white font-semibold text-lg mb-3 px-4 md:px-8">▶ Continuar Assistindo</h2>
      <div className="relative group/row">
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-0 bottom-0 z-10 w-10 bg-black/60 text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronLeft size={24} />
        </button>

        <div ref={rowRef} className="flex gap-3 overflow-x-auto scrollbar-hide px-4 md:px-8 pb-2 scroll-smooth">
          {items.map((item) => (
            <div key={item.historyId} className="flex-none w-36 md:w-44 relative group/card">
              {/* Card */}
              <Link href={watchUrl(item)} className="block relative aspect-[2/3] rounded-md overflow-hidden bg-zinc-900">
                {item.poster ? (
                  <Image
                    src={item.poster.startsWith("http") ? item.poster : `https://image.tmdb.org/t/p/w300${item.poster}`}
                    alt={item.titulo}
                    fill
                    className="object-cover"
                    sizes="176px"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs text-center px-2">
                    {item.titulo}
                  </div>
                )}

                {/* Overlay hover */}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/card:opacity-100 transition flex items-center justify-center">
                  <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur flex items-center justify-center">
                    <Play size={18} fill="white" className="text-white ml-0.5" />
                  </div>
                </div>

                {/* Badge próximo episódio */}
                {item.queued && item.progressoSeg === 0 && (
                  <div className="absolute top-1.5 left-1.5 bg-[#E50914] text-white text-[9px] font-bold px-1.5 py-0.5 rounded leading-none">
                    PRÓXIMO
                  </div>
                )}

                {/* Progress bar */}
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
                  <div
                    className="h-full bg-[#E50914]"
                    style={{ width: `${item.queued && item.progressoSeg === 0 ? 0 : pct(item)}%` }}
                  />
                </div>
              </Link>

              {/* Remover */}
              <button
                onClick={() => remove(item.historyId)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white/70 hover:text-white hover:bg-black transition opacity-0 group-hover/card:opacity-100 flex items-center justify-center z-10"
                title="Remover"
              >
                <X size={12} />
              </button>

              {/* Info */}
              <div className="mt-1.5 px-0.5">
                <p className="text-white/80 text-xs font-medium truncate">{item.titulo}</p>
                {label(item) && (
                  <p className="text-white/40 text-[10px] mt-0.5">{label(item)}</p>
                )}
              </div>
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
