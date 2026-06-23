"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ContentCard } from "@/components/ui/ContentCard";
import { Search } from "lucide-react";

type Aba = "tudo" | "filme" | "serie" | "anime";

export default function BuscarPage() {
  const sp = useSearchParams();
  const q = sp.get("q") ?? "";
  const [filmes, setFilmes] = useState<any[]>([]);
  const [series, setSeries] = useState<any[]>([]);
  const [aba, setAba] = useState<Aba>("tudo");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q) return;
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((d) => { setFilmes(d.filmes ?? []); setSeries(d.series ?? []); })
      .finally(() => setLoading(false));
  }, [q]);

  const abas: { id: Aba; label: string }[] = [
    { id: "tudo", label: "Tudo" },
    { id: "filme", label: "Filmes" },
    { id: "serie", label: "Séries" },
    { id: "anime", label: "Animes" },
  ];

  const filmesVisiveis = aba === "tudo" || aba === "filme" ? filmes : [];
  const seriesVisiveis = aba === "tudo" ? series : aba === "serie" ? series.filter((s) => s.tipo === "serie") : aba === "anime" ? series.filter((s) => s.tipo === "anime") : [];

  return (
    <div className="pt-20 px-4 md:px-8 pb-16 min-h-screen">
      <div className="flex items-center gap-3 mb-6">
        <Search size={20} className="text-zinc-400" />
        <h1 className="text-xl font-semibold text-white">
          {q ? `Resultados para "${q}"` : "Buscar"}
        </h1>
      </div>

      <div className="flex gap-2 mb-6">
        {abas.map((a) => (
          <button
            key={a.id}
            onClick={() => setAba(a.id)}
            className={`text-sm px-4 py-1.5 rounded-full transition ${aba === a.id ? "bg-red-600 text-white font-bold" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {loading && <p className="text-zinc-500 text-sm">Buscando...</p>}

      {!loading && q && filmesVisiveis.length === 0 && seriesVisiveis.length === 0 && (
        <p className="text-zinc-500 text-sm">Nenhum resultado encontrado.</p>
      )}

      {filmesVisiveis.length > 0 && (
        <div className="mb-8">
          {aba === "tudo" && <h2 className="text-white font-semibold mb-3">Filmes</h2>}
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-3">
            {filmesVisiveis.map((f) => (
              <ContentCard key={f.id} id={f.id} tipo="filme" titulo={f.titulo} poster={f.poster} ano={f.ano} nota={f.nota} urlDub={f.urlDub} urlLeg={f.urlLeg} />
            ))}
          </div>
        </div>
      )}

      {seriesVisiveis.length > 0 && (
        <div>
          {aba === "tudo" && <h2 className="text-white font-semibold mb-3">Séries</h2>}
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-3">
            {seriesVisiveis.map((s) => (
              <ContentCard key={s.id} id={s.id} tipo={s.tipo} titulo={s.titulo} poster={s.poster} ano={s.ano} nota={s.nota} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
