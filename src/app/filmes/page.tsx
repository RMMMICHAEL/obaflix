"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ContentCard } from "@/components/ui/ContentCard";

export const dynamic = "force-dynamic";

const ORDENS = [
  { value: "recente", label: "Mais Recente" },
  { value: "nota", label: "Melhor Nota" },
  { value: "az", label: "A-Z" },
];

function FilmesConteudo() {
  const router = useRouter();
  const sp = useSearchParams();
  const [filmes, setFilmes] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const genero = sp.get("genero") ?? "";
  const ano = sp.get("ano") ?? "";
  const ordem = sp.get("ordem") ?? "recente";

  const load = useCallback(async (p: number, reset: boolean) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), ordem });
    if (genero) params.set("genero", genero);
    if (ano) params.set("ano", ano);
    const res = await fetch(`/api/filmes?${params}`);
    const data = await res.json();
    setFilmes((prev) => reset ? data.filmes : [...prev, ...data.filmes]);
    setTotal(data.total);
    setLoading(false);
  }, [genero, ano, ordem]);

  useEffect(() => { setPage(1); load(1, true); }, [load]);

  const setParam = (key: string, val: string) => {
    const params = new URLSearchParams(sp.toString());
    if (val) params.set(key, val); else params.delete(key);
    router.push(`/filmes?${params}`);
  };

  return (
    <div className="pt-20 px-4 md:px-8 pb-16">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-white mr-4">Filmes</h1>
        <span className="text-zinc-500 text-sm">{total.toLocaleString()} resultados</span>
        <div className="flex gap-2 ml-auto flex-wrap">
          {ORDENS.map((o) => (
            <button
              key={o.value}
              onClick={() => setParam("ordem", o.value)}
              className={`text-xs px-3 py-1.5 rounded transition ${ordem === o.value ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 gap-3">
        {filmes.map((f) => (
          <ContentCard key={f.id} id={f.id} tipo="filme" titulo={f.titulo} poster={f.poster} ano={f.ano} nota={f.nota} urlDub={f.urlDub} urlLeg={f.urlLeg} />
        ))}
      </div>

      {filmes.length < total && (
        <div className="flex justify-center mt-8">
          <button
            onClick={() => { const p = page + 1; setPage(p); load(p, false); }}
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

export default function FilmesPage() {
  return (
    <Suspense fallback={<div className="pt-20 px-8 text-zinc-500 text-sm">Carregando...</div>}>
      <FilmesConteudo />
    </Suspense>
  );
}
