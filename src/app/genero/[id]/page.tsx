"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ContentCard } from "@/components/ui/ContentCard";

const ORDENS = [
  { value: "recente", label: "Mais Recente" },
  { value: "nota", label: "Melhor Nota" },
  { value: "az", label: "A-Z" },
];

function GeneroConteudo() {
  const params = useParams();
  const generoId = params.id as string;

  const [nomeGenero, setNomeGenero] = useState<string>("");
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [ordem, setOrdem] = useState("recente");

  const load = useCallback(async (p: number, reset: boolean, ord: string) => {
    setLoading(true);
    const [filmesRes, seriesRes] = await Promise.all([
      fetch(`/api/filmes?page=${p}&genero=${generoId}&ordem=${ord}`),
      fetch(`/api/series?page=${p}&genero=${generoId}&ordem=${ord}`),
    ]);
    const filmesData = await filmesRes.json();
    const seriesData = await seriesRes.json();

    if (filmesData.filmes?.[0]) {
      const g = filmesData.filmes[0].generos?.find((g: any) => String(g.genero.id) === generoId);
      if (g) setNomeGenero(g.genero.nome);
    }
    if (!nomeGenero && seriesData.series?.[0]) {
      const g = seriesData.series[0].generos?.find((g: any) => String(g.genero.id) === generoId);
      if (g) setNomeGenero(g.genero.nome);
    }

    const filmes = (filmesData.filmes ?? []).map((f: any) => ({ ...f, tipo: "filme" as const }));
    const series = (seriesData.series ?? []).map((s: any) => ({ ...s, tipo: s.tipo ?? "serie" }));

    // Interleave filmes and series for variety
    const merged: any[] = [];
    let fi = 0, si = 0;
    while (fi < filmes.length || si < series.length) {
      if (fi < filmes.length) merged.push(filmes[fi++]);
      if (si < series.length) merged.push(series[si++]);
    }

    setItems((prev) => reset ? merged : [...prev, ...merged]);
    setTotal((filmesData.total ?? 0) + (seriesData.total ?? 0));
    setLoading(false);
  }, [generoId]);

  useEffect(() => {
    setPage(1);
    load(1, true, ordem);
  }, [generoId, ordem]);

  return (
    <div className="pt-20 px-4 md:px-8 pb-16">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-white mr-4">
          {nomeGenero ? nomeGenero : "Gênero"}
        </h1>
        <span className="text-zinc-500 text-sm">{total.toLocaleString()} resultados</span>
        <div className="flex gap-2 ml-auto flex-wrap">
          {ORDENS.map((o) => (
            <button
              key={o.value}
              onClick={() => setOrdem(o.value)}
              className={`text-xs px-3 py-1.5 rounded transition ${ordem === o.value ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 && !loading && (
        <p className="text-zinc-500 text-sm">Nenhum conteúdo encontrado para este gênero.</p>
      )}

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 gap-3">
        {items.map((item) => (
          <ContentCard
            key={`${item.tipo}-${item.id}`}
            id={item.id}
            tipo={item.tipo}
            titulo={item.titulo}
            poster={item.poster}
            ano={item.ano}
            nota={item.nota}
            urlDub={item.urlDub}
            urlLeg={item.urlLeg}
          />
        ))}
      </div>

      {items.length < total && (
        <div className="flex justify-center mt-8">
          <button
            onClick={() => { const p = page + 1; setPage(p); load(p, false, ordem); }}
            disabled={loading}
            className="bg-zinc-800 text-white px-8 py-2.5 rounded hover:bg-zinc-700 transition disabled:opacity-50"
          >
            {loading ? "Carregando..." : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function GeneroPage() {
  return (
    <Suspense fallback={<div className="pt-20 px-8 text-zinc-500 text-sm">Carregando...</div>}>
      <GeneroConteudo />
    </Suspense>
  );
}
