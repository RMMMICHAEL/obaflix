"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Play } from "lucide-react";
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

export function EpisodeGrid({ serieId, episodios, temporadas }: { serieId: string; episodios: Ep[]; temporadas: number[] }) {
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
        {eps.map((ep) => (
          <Link
            key={ep.id}
            href={`/assistir/serie/${serieId}/t${ep.temporada}/ep${ep.numeroEp}`}
            className="group flex gap-3 bg-zinc-900 hover:bg-zinc-800 rounded-lg p-3 transition"
          >
            <div className="relative w-32 h-20 shrink-0 rounded overflow-hidden bg-zinc-800">
              {ep.thumbnail ? (
                <Image src={imgUrl(ep.thumbnail, "w300")} alt={ep.titulo ?? ""} fill className="object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Play size={20} className="text-zinc-600" />
                </div>
              )}
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/50 transition">
                <Play size={24} className="text-white" fill="white" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-zinc-500 text-xs">EP {ep.numeroEp}</span>
                {isNovo(ep.createdAt) && (
                  <span className="text-[10px] bg-red-600 text-white px-1.5 py-0.5 rounded font-bold">NOVO</span>
                )}
              </div>
              <p className="text-zinc-200 text-sm font-medium line-clamp-2">{ep.titulo ?? `Episódio ${ep.numeroEp}`}</p>
              <div className="flex gap-1 mt-1">
                {ep.urlDub && <span className="text-[10px] bg-blue-700 text-white px-1 py-0.5 rounded">DUB</span>}
                {ep.urlLeg && <span className="text-[10px] bg-zinc-700 text-white px-1 py-0.5 rounded">LEG</span>}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
