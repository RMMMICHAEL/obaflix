"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Star, Play } from "lucide-react";

export interface ChartItem {
  tmdbId: string;
  titulo: string;
  ano: string;
  nota: number;
  poster: string | null;
  catalogId: string | null;
}

type TabId = "top-filmes" | "top-series" | "pop-filmes" | "pop-series";

const TABS: { id: TabId; label: string }[] = [
  { id: "top-filmes", label: "Top 250 Filmes" },
  { id: "top-series", label: "Top 250 Séries" },
  { id: "pop-filmes", label: "Filmes Populares" },
  { id: "pop-series", label: "Séries Populares" },
];

interface Props {
  topFilmes: ChartItem[];
  topSeries: ChartItem[];
  popFilmes: ChartItem[];
  popSeries: ChartItem[];
}

export function MelhoresClient({ topFilmes, topSeries, popFilmes, popSeries }: Props) {
  const [tab, setTab] = useState<TabId>("top-filmes");
  const [search, setSearch] = useState("");

  const allItems: Record<TabId, ChartItem[]> = {
    "top-filmes": topFilmes,
    "top-series": topSeries,
    "pop-filmes": popFilmes,
    "pop-series": popSeries,
  };

  const items = allItems[tab];
  const tipo = tab.includes("series") || tab.includes("series") ? "serie" : "filme";
  const tipoPath = tab === "top-series" || tab === "pop-series" ? "serie" : "filme";

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((i) => i.titulo.toLowerCase().includes(q));
  }, [items, search]);

  const disponiveisCount = items.filter((i) => i.catalogId).length;

  return (
    <div className="min-h-screen pt-20 pb-16 px-4 md:px-14">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-white text-2xl md:text-3xl font-bold tracking-tight">
            Melhores do Mundo
          </h1>
          <p className="text-zinc-500 text-sm mt-1">
            Ranking baseado nas avaliações do TMDB •{" "}
            <span className="text-green-500">{disponiveisCount} disponíveis</span>{" "}
            nesta lista
          </p>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setSearch("");
              }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                tab === t.id
                  ? "bg-red-600 text-white shadow-lg shadow-red-900/30"
                  : "bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filtrar por título..."
          className="w-full bg-zinc-900 text-white text-sm px-4 py-2.5 rounded-xl outline-none border border-zinc-800 focus:border-zinc-600 mb-3 transition-colors"
        />

        {/* Result count */}
        <p className="text-zinc-600 text-xs mb-3 px-1">
          {search
            ? `${filtered.length} resultado${filtered.length !== 1 ? "s" : ""} para "${search}"`
            : `${items.length} títulos`}
        </p>

        {/* Chart list */}
        <div className="divide-y divide-zinc-800/40">
          {filtered.map((item, i) => {
            const rank = search ? null : i + 1;
            const href = item.catalogId ? `/${tipoPath}/${item.catalogId}` : null;

            return (
              <div
                key={item.tmdbId}
                className={`flex items-center gap-4 py-4 px-3 rounded-xl transition-colors group ${
                  href ? "hover:bg-zinc-800/60" : "opacity-40"
                }`}
              >
                {/* Rank number */}
                <div
                  className={`w-12 text-right shrink-0 font-black tabular-nums leading-none ${
                    rank == null
                      ? "invisible"
                      : rank <= 10
                      ? "text-yellow-400 text-3xl"
                      : rank <= 50
                      ? "text-zinc-300 text-2xl"
                      : rank <= 100
                      ? "text-zinc-500 text-xl"
                      : "text-zinc-700 text-lg"
                  }`}
                >
                  {rank ?? "–"}
                </div>

                {/* Poster */}
                <div className="w-16 h-24 shrink-0 rounded-lg overflow-hidden bg-zinc-800 shadow-lg">
                  {item.poster ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.poster}
                      alt={item.titulo}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-600 text-sm">
                      ?
                    </div>
                  )}
                </div>

                {/* Title + meta */}
                <div className="flex-1 min-w-0">
                  {href ? (
                    <Link
                      href={href}
                      className="text-white text-base md:text-lg font-semibold hover:text-red-400 transition-colors line-clamp-2 block leading-snug"
                    >
                      {item.titulo}
                    </Link>
                  ) : (
                    <span className="text-zinc-400 text-base md:text-lg font-semibold line-clamp-2 block leading-snug">
                      {item.titulo}
                    </span>
                  )}
                  <div className="flex items-center gap-3 mt-1.5">
                    {item.ano && (
                      <span className="text-zinc-500 text-sm">{item.ano}</span>
                    )}
                    {item.nota > 0 && (
                      <span className="flex items-center gap-1 text-yellow-400 text-sm font-bold">
                        <Star size={13} fill="currentColor" />
                        {item.nota.toFixed(1)}
                      </span>
                    )}
                    {!item.catalogId && (
                      <span className="text-zinc-600 text-xs">indisponível</span>
                    )}
                  </div>
                </div>

                {/* Assistir button */}
                {href && (
                  <Link
                    href={href}
                    className="shrink-0 flex items-center gap-1.5 bg-red-600 text-white text-sm font-bold px-4 py-2 rounded-xl transition-all opacity-0 group-hover:opacity-100 hover:bg-red-500"
                  >
                    <Play size={13} fill="white" strokeWidth={0} />
                    Assistir
                  </Link>
                )}
              </div>
            );
          })}
        </div>

        {filtered.length === 0 && (
          <p className="text-zinc-600 text-center py-16 text-sm">
            Nenhum título encontrado.
          </p>
        )}
      </div>
    </div>
  );
}
