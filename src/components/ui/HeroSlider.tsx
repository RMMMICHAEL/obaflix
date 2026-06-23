"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Play, Info } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

interface HeroItem {
  id: string;
  tipo: string;
  titulo: string;
  sinopse: string | null;
  background: string | null;
}

export function HeroSlider({ items }: { items: HeroItem[] }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), 8000);
    return () => clearInterval(t);
  }, [items.length]);

  if (!items.length) return null;
  const item = items[idx];
  const isFilme = !item.tipo || item.tipo === "filme";

  return (
    <div className="relative h-[70vh] min-h-[400px] w-full overflow-hidden">
      <Image
        src={item.background ? imgUrl(item.background, "original") : "/placeholder-bg.jpg"}
        alt={item.titulo}
        fill
        className="object-cover transition-opacity duration-700"
        priority
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/50 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-transparent" />

      <div className="absolute bottom-16 left-4 md:left-16 max-w-xl">
        <h1 className="text-white font-bold text-3xl md:text-5xl mb-3 drop-shadow-lg">{item.titulo}</h1>
        {item.sinopse && (
          <p className="text-zinc-300 text-sm md:text-base line-clamp-2 mb-5">{item.sinopse}</p>
        )}
        <div className="flex gap-3">
          <Link
            href={isFilme ? `/assistir/filme/${item.id}` : `/serie/${item.id}`}
            className="flex items-center gap-2 bg-white text-black font-bold px-6 py-2.5 rounded hover:bg-zinc-200 transition"
          >
            <Play size={18} fill="black" /> Assistir
          </Link>
          <Link
            href={isFilme ? `/filme/${item.id}` : `/serie/${item.id}`}
            className="flex items-center gap-2 bg-zinc-700/80 text-white font-semibold px-6 py-2.5 rounded hover:bg-zinc-600 transition"
          >
            <Info size={18} /> Mais Info
          </Link>
        </div>
      </div>

      {/* dots */}
      <div className="absolute bottom-6 left-4 md:left-16 flex gap-2">
        {items.map((_, i) => (
          <button
            key={i}
            onClick={() => setIdx(i)}
            className={`w-2 h-2 rounded-full transition ${i === idx ? "bg-white" : "bg-zinc-600"}`}
          />
        ))}
      </div>
    </div>
  );
}
