"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, Play } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

interface Ep {
  id: string;
  serieId: string;
  numeroEp: number;
  temporada: number;
  titulo: string | null;
  thumbnail: string | null;
  urlDub: string | null;
  urlLeg: string | null;
  createdAt: Date;
}

interface EpProgress {
  progressoSeg: number;
  duracaoSeg: number | null;
  concluido: boolean;
}

export function EpisodeGrid({
  serieId,
  episodios,
  temporadas,
  progresso = {},
}: {
  serieId: string;
  episodios: Ep[];
  temporadas: number[];
  progresso?: Record<string, EpProgress>;
}) {
  const [temp, setTemp] = useState(temporadas[0] ?? 1);
  const eps = episodios.filter((e) => e.temporada === temp);

  const isNovo = (d: Date) => Date.now() - new Date(d).getTime() < 7 * 24 * 3600 * 1000;

  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <span className="text-white font-semibold">Temporada:</span>
        <div className="flex gap-2 flex-wrap">
          {temporadas.map((t) => (
            <button
              key={t}
              onClick={() => setTemp(t)}
              className={`text-sm px-4 py-1.5 rounded transition ${t === temp ? "bg-red-600 text-white font-bold" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {eps.map((ep) => {
          const p = progresso[ep.id];
          const isWatched = p?.concluido === true;
          const isWatching = !isWatched && !!p && p.progressoSeg > 30;
          const watchPct =
            isWatching && p.duracaoSeg
              ? Math.min(100, (p.progressoSeg / p.duracaoSeg) * 100)
              : 0;

          return (
            <Link
              key={ep.id}
              href={`/assistir/serie/${serieId}/t${ep.temporada}/ep${ep.numeroEp}`}
              className="group flex gap-3 bg-zinc-900 hover:bg-zinc-800 rounded-lg p-3 transition"
            >
              {/* Thumbnail */}
              <div className="relative w-32 h-20 shrink-0 rounded overflow-hidden bg-zinc-800">
                {ep.thumbnail ? (
                  <Image src={imgUrl(ep.thumbnail, "w300")} alt={ep.titulo ?? ""} fill className="object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Play size={20} className="text-zinc-600" />
                  </div>
                )}

                {/* Overlay assistido */}
                {isWatched && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <div className="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center">
                      <Check size={16} className="text-white" strokeWidth={3} />
                    </div>
                  </div>
                )}

                {/* Overlay hover */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/50 transition">
                  <Play size={24} className="text-white" fill="white" />
                </div>

                {/* Barra de progresso no thumbnail */}
                {isWatching && (
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
                    <div className="h-full bg-[#E50914]" style={{ width: `${watchPct}%` }} />
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-zinc-500 text-xs">EP {ep.numeroEp}</span>
                  {isNovo(ep.createdAt) && !isWatched && (
                    <span className="text-[10px] bg-red-600 text-white px-1.5 py-0.5 rounded font-bold">NOVO</span>
                  )}
                  {isWatched && (
                    <span className="text-[10px] bg-green-700 text-white px-1.5 py-0.5 rounded font-bold">ASSISTIDO</span>
                  )}
                  {isWatching && (
                    <span className="text-[10px] bg-yellow-600 text-white px-1.5 py-0.5 rounded font-bold">ASSISTINDO...</span>
                  )}
                </div>
                <p className="text-zinc-200 text-sm font-medium line-clamp-2">{ep.titulo ?? `Episódio ${ep.numeroEp}`}</p>
                <div className="flex gap-1 mt-1">
                  {ep.urlDub && <span className="text-[10px] bg-blue-700 text-white px-1 py-0.5 rounded">DUB</span>}
                  {ep.urlLeg && <span className="text-[10px] bg-zinc-700 text-white px-1 py-0.5 rounded">LEG</span>}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
