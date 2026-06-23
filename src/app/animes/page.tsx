"use client";

import { useEffect, useState } from "react";
import { ContentCard } from "@/components/ui/ContentCard";

export default function AnimesPage() {
  const [animes, setAnimes] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = async (p: number, reset: boolean) => {
    setLoading(true);
    const res = await fetch(`/api/series?tipo=anime&page=${p}`);
    const data = await res.json();
    setAnimes((prev) => reset ? data.series : [...prev, ...data.series]);
    setTotal(data.total);
    setLoading(false);
  };

  useEffect(() => { load(1, true); }, []);

  return (
    <div className="pt-20 px-4 md:px-8 pb-16">
      <h1 className="text-2xl font-bold text-white mb-6">Animes <span className="text-zinc-500 text-sm font-normal">{total.toLocaleString()}</span></h1>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 gap-3">
        {animes.map((s) => <ContentCard key={s.id} id={s.id} tipo="anime" titulo={s.titulo} poster={s.poster} ano={s.ano} nota={s.nota} />)}
      </div>
      {animes.length < total && (
        <div className="flex justify-center mt-8">
          <button onClick={() => { const p = page + 1; setPage(p); load(p, false); }} disabled={loading}
            className="bg-zinc-800 text-white px-8 py-2.5 rounded hover:bg-zinc-700 transition disabled:opacity-50">
            {loading ? "Carregando..." : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}
