"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Play } from "lucide-react";
import { ContentCard } from "@/components/ui/ContentCard";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";

function imgUrl(path: string | null | undefined) {
  if (!path) return "/placeholder-bg.jpg";
  if (path.startsWith("http")) return path;
  return `https://image.tmdb.org/t/p/original${path}`;
}

function SectionHero({ item }: { item: any }) {
  if (!item?.background) return null;
  return (
    <div className="relative h-[52vh] min-h-[280px] w-full overflow-hidden">
      <Image src={imgUrl(item.background)} alt={item.titulo} fill className="object-cover" priority />
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/50 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-transparent" />
      <div className="absolute bottom-14 left-4 md:left-8 max-w-lg z-10">
        <p className="text-xs font-bold text-red-500 uppercase tracking-widest mb-2">Em Destaque</p>
        <h2 className="text-white font-black text-2xl md:text-4xl mb-3 leading-tight">{item.titulo}</h2>
        {item.sinopse && <p className="text-zinc-300 text-sm line-clamp-2 mb-4 max-w-md">{item.sinopse}</p>}
        <Link
          href={`/serie/${item.id}`}
          className="inline-flex items-center gap-2 bg-white text-black font-bold px-5 py-2.5 rounded-lg hover:bg-zinc-100 transition text-sm"
        >
          <Play size={15} fill="black" /> Assistir
        </Link>
      </div>
    </div>
  );
}

export default function AnimesPage() {
  const [animes, setAnimes] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [hero, setHero] = useState<any>(null);

  const load = async (p: number, reset: boolean) => {
    setLoading(true);
    const res = await fetch(`/api/series?tipo=anime&page=${p}&ordem=nota`);
    const data = await res.json();
    const items = data.series ?? [];
    setAnimes((prev) => reset ? items : [...prev, ...items]);
    setTotal(data.total);
    if (reset) setHero(items.find((s: any) => s.background) ?? null);
    setLoading(false);
  };

  useEffect(() => { load(1, true); }, []);

  return (
    <div className="min-h-screen">
      <SectionHero item={hero} />
      <div className={`px-4 md:px-8 pb-16 ${hero ? "pt-4" : "pt-20"}`}>
        <div className="mb-2">
          <ContinuarAssistindo />
        </div>
        <h1 className="text-2xl font-bold text-white mb-6">
          Animes <span className="text-zinc-500 text-sm font-normal">{total.toLocaleString()}</span>
        </h1>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 gap-3">
          {animes.map((s) => (
            <ContentCard key={s.id} id={s.id} tipo="anime" titulo={s.titulo} poster={s.poster} ano={s.ano} nota={s.nota} />
          ))}
        </div>
        {animes.length < total && (
          <div className="flex justify-center mt-10">
            <button
              onClick={() => { const p = page + 1; setPage(p); load(p, false); }}
              disabled={loading}
              className="bg-zinc-800 text-white px-10 py-3 rounded-lg hover:bg-zinc-700 transition disabled:opacity-50 font-semibold text-sm"
            >
              {loading ? "Carregando..." : "Carregar mais"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
