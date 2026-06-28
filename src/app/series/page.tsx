"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Play } from "lucide-react";
import { ContentCard } from "@/components/ui/ContentCard";
import { ContinuarAssistindo } from "@/components/ui/ContinuarAssistindo";

export const dynamic = "force-dynamic";

const ORDENS = [
  { value: "recente", label: "Mais Recente" },
  { value: "nota", label: "Melhor Nota" },
  { value: "az", label: "A-Z" },
];

const GENRES = [
  { id: 18, nome: "Drama" },
  { id: 80, nome: "Crime" },
  { id: 35, nome: "Comédia" },
  { id: 10759, nome: "Ação" },
  { id: 9648, nome: "Mistério" },
  { id: 10765, nome: "Ficção Científica" },
  { id: 27, nome: "Terror" },
  { id: 10749, nome: "Romance" },
];

function imgUrl(path: string | null | undefined) {
  if (!path) return "/placeholder-bg.jpg";
  if (path.startsWith("http")) return path;
  return `https://image.tmdb.org/t/p/original${path}`;
}

function SectionHero({ item }: { item: any }) {
  if (!item?.background) return null;
  const href = `/serie/${item.id}`;
  return (
    <div className="relative h-[52vh] min-h-[280px] w-full overflow-hidden">
      <Image src={imgUrl(item.background)} alt={item.titulo} fill className="object-cover" priority />
      <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/50 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-transparent to-transparent" />
      <div className="absolute bottom-14 left-4 md:left-8 max-w-lg z-10">
        <p className="text-xs font-bold text-red-500 uppercase tracking-widest mb-2">Em Destaque</p>
        <h2 className="text-white font-black text-2xl md:text-4xl mb-3 leading-tight">{item.titulo}</h2>
        {item.sinopse && (
          <p className="text-zinc-300 text-sm line-clamp-2 mb-4 max-w-md">{item.sinopse}</p>
        )}
        <Link
          href={href}
          className="inline-flex items-center gap-2 bg-white text-black font-bold px-5 py-2.5 rounded-lg hover:bg-zinc-100 transition text-sm"
        >
          <Play size={15} fill="black" /> Assistir
        </Link>
      </div>
    </div>
  );
}

function SeriesConteudo() {
  const router = useRouter();
  const sp = useSearchParams();
  const [series, setSeries] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [hero, setHero] = useState<any>(null);

  const genero = sp.get("genero") ?? "";
  const ano = sp.get("ano") ?? "";
  const ordem = sp.get("ordem") ?? "recente";

  const load = useCallback(async (p: number, reset: boolean) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), ordem, tipo: "serie" });
    if (genero) params.set("genero", genero);
    if (ano) params.set("ano", ano);
    const res = await fetch(`/api/series?${params}`);
    const data = await res.json();
    const items = data.series ?? [];
    setSeries((prev) => reset ? items : [...prev, ...items]);
    setTotal(data.total);
    if (reset) {
      const withBg = items.find((s: any) => s.background);
      setHero(withBg ?? null);
    }
    setLoading(false);
  }, [genero, ano, ordem]);

  useEffect(() => { setPage(1); load(1, true); }, [load]);

  const setParam = (key: string, val: string) => {
    const params = new URLSearchParams(sp.toString());
    if (val) params.set(key, val); else params.delete(key);
    router.push(`/series?${params}`);
  };

  return (
    <div className="min-h-screen">
      <SectionHero item={hero} />

      <div className={`px-4 md:px-8 pb-16 ${hero ? "pt-4" : "pt-20"}`}>
        <div className="mb-2">
          <ContinuarAssistindo />
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-6">
          <h1 className="text-2xl font-bold text-white mr-2">Séries</h1>
          <span className="text-zinc-500 text-sm">{total.toLocaleString()} títulos</span>

          <div className="flex gap-2 overflow-x-auto scrollbar-hide">
            <button
              onClick={() => setParam("genero", "")}
              className={`flex-none text-xs px-3 py-1.5 rounded-full border transition ${!genero ? "bg-white text-black border-white" : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white"}`}
            >
              Todas
            </button>
            {GENRES.map((g) => (
              <button
                key={g.id}
                onClick={() => setParam("genero", String(g.id))}
                className={`flex-none text-xs px-3 py-1.5 rounded-full border transition ${genero === String(g.id) ? "bg-red-600 text-white border-red-600" : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white"}`}
              >
                {g.nome}
              </button>
            ))}
          </div>

          <div className="flex gap-2 ml-auto">
            {ORDENS.map((o) => (
              <button
                key={o.value}
                onClick={() => setParam("ordem", o.value)}
                className={`text-xs px-3 py-1.5 rounded-lg transition ${ordem === o.value ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-white"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 gap-3">
          {series.map((s) => (
            <ContentCard key={s.id} id={s.id} tipo={s.tipo ?? "serie"} titulo={s.titulo} poster={s.poster} ano={s.ano} nota={s.nota} />
          ))}
        </div>

        {series.length < total && (
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

export default function SeriesPage() {
  return (
    <Suspense fallback={<div className="pt-20 px-8 text-zinc-500 text-sm">Carregando...</div>}>
      <SeriesConteudo />
    </Suspense>
  );
}
