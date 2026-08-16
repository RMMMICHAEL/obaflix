"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronRight, ListFilter, Play, Search, Star, Trophy, X } from "lucide-react";
import { AwardRow, type AwardRowItem } from "@/components/ui/AwardRow";

export interface ChartItem {
  id: string;
  titulo: string;
  ano: string;
  nota: number;
  poster: string | null;
  background: string | null;
  logo: string | null;
  sinopse: string | null;
  detalhe: string | null;
  generos: string[];
  rank: number;
  disponivel: boolean;
}

type TabId = "top-filmes" | "top-series" | "pop-filmes" | "pop-series";

const TABS: { id: TabId; label: string; eyebrow: string }[] = [
  { id: "top-filmes", label: "Top filmes", eyebrow: "IMDb Top 250" },
  { id: "top-series", label: "Top séries", eyebrow: "IMDb Top 250" },
  { id: "pop-filmes", label: "Filmes em alta", eyebrow: "Popularidade TMDB" },
  { id: "pop-series", label: "Séries em alta", eyebrow: "Popularidade TMDB" },
];

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

function deduplicate(items: ChartItem[]) {
  const unique = new Map<string, ChartItem>();
  for (const item of items) {
    const key = `${normalize(item.titulo)}:${item.ano}`;
    const current = unique.get(key);
    if (!current || (!current.disponivel && item.disponivel) || (current.disponivel === item.disponivel && item.rank < current.rank)) {
      unique.set(key, item);
    }
  }
  return [...unique.values()].sort((a, b) => a.rank - b.rank);
}

interface Props {
  topFilmes: ChartItem[];
  topSeries: ChartItem[];
  popFilmes: ChartItem[];
  popSeries: ChartItem[];
  oscarItems: AwardRowItem[];
  emmyItems: AwardRowItem[];
}

export function MelhoresClient({ topFilmes, topSeries, popFilmes, popSeries, oscarItems, emmyItems }: Props) {
  const [tab, setTab] = useState<TabId>("pop-filmes");
  const [search, setSearch] = useState("");
  const [genre, setGenre] = useState("");
  const [releaseYear, setReleaseYear] = useState("");
  const allItems: Record<TabId, ChartItem[]> = {
    "top-filmes": topFilmes,
    "top-series": topSeries,
    "pop-filmes": popFilmes,
    "pop-series": popSeries,
  };

  const sourceItems = allItems[tab];
  const items = useMemo(() => deduplicate(sourceItems), [sourceItems]);
  const isSeries = tab === "top-series" || tab === "pop-series";
  const tipoPath = isSeries ? "serie" : "filme";
  const activeTab = TABS.find((item) => item.id === tab)!;
  const genreOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const item of items) {
      for (const name of item.generos) {
        const key = normalize(name);
        if (!options.has(key)) options.set(key, name);
      }
    }
    return [...options].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  }, [items]);
  const yearOptions = useMemo(
    () => [...new Set(items.map((item) => item.ano).filter(Boolean))].sort((a, b) => Number(b) - Number(a)),
    [items],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("pt-BR");
    return items.filter((item) => {
      if (query && !item.titulo.toLocaleLowerCase("pt-BR").includes(query)) return false;
      if (genre && !item.generos.some((name) => normalize(name) === genre)) return false;
      if (releaseYear && item.ano !== releaseYear) return false;
      return true;
    });
  }, [genre, items, releaseYear, search]);

  const hero = filtered.find((item) => item.disponivel) ?? filtered[0];
  const hasActiveFilters = Boolean(search || genre || releaseYear);

  const heroHref = hero ? `/${tipoPath}/${hero.id}` : "#";

  return (
    <main className="min-h-screen bg-[oklch(0.105_0.008_25)] pb-20 text-[oklch(0.96_0.006_25)]">
      {hero && (
        <section className="relative min-h-[72svh] overflow-hidden pt-20 md:min-h-[78svh]">
          {hero.background || hero.poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={hero.id}
              src={hero.background || hero.poster || ""}
              alt=""
              className="absolute inset-0 h-full w-full object-cover object-center motion-safe:animate-[cinematic-fade_.35s_cubic-bezier(.16,1,.3,1)]"
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-r from-[oklch(0.105_0.008_25)] via-[oklch(0.105_0.008_25/0.84)] to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-[oklch(0.105_0.008_25)] via-transparent to-[oklch(0.105_0.008_25/0.28)]" />

          <div className="relative z-10 flex min-h-[calc(72svh-5rem)] max-w-7xl items-end px-5 pb-14 md:min-h-[calc(78svh-5rem)] md:items-center md:px-14 md:pb-0">
            <div className="max-w-2xl">
              <div className="mb-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.18em] text-[oklch(0.78_0.02_25)]">
                <Trophy size={16} className="text-[oklch(0.68_0.22_28)]" />
                {activeTab.eyebrow}
                <span className="h-1 w-1 rounded-full bg-current opacity-50" />
                Número {hero.rank}
              </div>

              {hero.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={hero.logo} alt={hero.titulo} className="mb-5 max-h-28 max-w-[72vw] object-contain object-left md:max-h-40 md:max-w-md" />
              ) : (
                <h1 className="mb-5 max-w-xl text-4xl font-black leading-[0.96] tracking-[-0.045em] md:text-7xl">{hero.titulo}</h1>
              )}

              <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-medium text-[oklch(0.82_0.012_25)]">
                {hero.nota > 0 && <span className="flex items-center gap-1.5 text-[oklch(0.84_0.16_88)]"><Star size={15} fill="currentColor" /> {hero.nota.toFixed(1)}</span>}
                {hero.ano && <span>{hero.ano}</span>}
                {hero.detalhe && <span>{hero.detalhe}</span>}
                <span className="rounded border border-[oklch(0.7_0.01_25/0.55)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider">Top {hero.rank}</span>
              </div>

              {hero.sinopse && <p className="mb-7 line-clamp-4 max-w-[65ch] text-sm leading-relaxed text-[oklch(0.84_0.012_25)] md:text-base">{hero.sinopse}</p>}

              <div className="flex flex-wrap gap-3">
                {hero.disponivel && (
                  <Link href={heroHref} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[oklch(0.96_0.006_25)] px-6 text-sm font-bold text-[oklch(0.16_0.01_25)] transition duration-200 ease-out hover:bg-[oklch(0.86_0.008_25)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                    <Play size={18} fill="currentColor" /> Assistir
                  </Link>
                )}
                <Link href={heroHref} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[oklch(0.35_0.012_25/0.86)] px-5 text-sm font-semibold transition duration-200 ease-out hover:bg-[oklch(0.42_0.012_25)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
                  Ver detalhes <ChevronRight size={17} />
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="relative z-20 mx-auto -mt-1 max-w-7xl px-4 md:px-14">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(0.62_0.16_28)]">Curadoria mundial</p>
            <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Melhores do Mundo</h2>
          </div>

          <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-[oklch(0.16_0.009_25)] p-1 scrollbar-hide" role="tablist" aria-label="Listas de melhores">
            {TABS.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => { setTab(item.id); setSearch(""); setGenre(""); setReleaseYear(""); }}
                className={`min-h-10 whitespace-nowrap rounded-md px-3.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${tab === item.id ? "bg-[oklch(0.29_0.014_25)] text-white" : "text-[oklch(0.66_0.01_25)] hover:text-white"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-8 mt-5 border-y border-[oklch(0.28_0.009_25/0.65)] py-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-[oklch(0.34_0.01_25)] bg-[oklch(0.14_0.008_25)] px-3 focus-within:border-[oklch(0.58_0.02_25)]">
              <Search size={16} className="shrink-0 text-[oklch(0.58_0.01_25)]" aria-hidden="true" />
              <span className="sr-only">Buscar nesta lista</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar título" className="w-full bg-transparent text-sm outline-none placeholder:text-[oklch(0.52_0.01_25)]" />
            </label>

            <label className="flex min-h-11 min-w-52 items-center gap-2 rounded-lg border border-[oklch(0.34_0.01_25)] bg-[oklch(0.14_0.008_25)] px-3 focus-within:border-[oklch(0.58_0.02_25)]">
              <ListFilter size={16} className="shrink-0 text-[oklch(0.58_0.01_25)]" aria-hidden="true" />
              <span className="sr-only">Filtrar por gênero</span>
              <select value={genre} onChange={(event) => setGenre(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none">
                <option value="" className="bg-zinc-900">Todos os gêneros</option>
                {genreOptions.map((option) => <option key={option.value} value={option.value} className="bg-zinc-900">{option.label}</option>)}
              </select>
            </label>

            <label className="flex min-h-11 min-w-44 items-center gap-2 rounded-lg border border-[oklch(0.34_0.01_25)] bg-[oklch(0.14_0.008_25)] px-3 focus-within:border-[oklch(0.58_0.02_25)]">
              <CalendarDays size={16} className="shrink-0 text-[oklch(0.58_0.01_25)]" aria-hidden="true" />
              <span className="sr-only">Filtrar por ano de lançamento</span>
              <select value={releaseYear} onChange={(event) => setReleaseYear(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none">
                <option value="" className="bg-zinc-900">Todos os anos</option>
                {yearOptions.map((year) => <option key={year} value={year} className="bg-zinc-900">{year}</option>)}
              </select>
            </label>

            {hasActiveFilters && (
              <button type="button" onClick={() => { setSearch(""); setGenre(""); setReleaseYear(""); }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-xs font-semibold text-[oklch(0.68_0.012_25)] transition-colors hover:bg-[oklch(0.18_0.01_25)] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
                <X size={15} aria-hidden="true" /> Limpar filtros
              </button>
            )}
          </div>
          <p className="mt-3 text-xs text-[oklch(0.55_0.01_25)]" aria-live="polite">
            {filtered.length} {filtered.length === 1 ? "título encontrado" : "títulos encontrados"}
          </p>
        </div>

        <div className="grid gap-x-8 lg:grid-cols-2">
          {filtered.map((item) => {
            const href = `/${tipoPath}/${item.id}`;
            return (
              <Link
                key={item.id}
                href={href}
                aria-label={`${item.rank}. ${item.titulo}`}
                className={`group flex min-h-32 items-center gap-4 border-b border-[oklch(0.28_0.009_25/0.65)] py-4 transition-colors duration-200 hover:bg-[oklch(0.16_0.01_25)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:px-3 ${item.disponivel ? "" : "opacity-55"}`}
              >
                <span className={`w-12 shrink-0 text-right text-3xl font-black tabular-nums tracking-[-0.06em] ${item.rank <= 3 ? "text-[oklch(0.74_0.18_65)]" : "text-[oklch(0.48_0.012_25)]"}`}>{item.rank}</span>
                <div className="relative h-28 w-20 shrink-0 overflow-hidden rounded-md bg-[oklch(0.2_0.01_25)]">
                  {item.poster && <img src={item.poster} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 ease-out motion-safe:group-hover:scale-105" />}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="line-clamp-2 text-base font-semibold leading-snug transition-colors group-hover:text-[oklch(0.75_0.16_28)] md:text-lg">{item.titulo}</h3>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[oklch(0.62_0.01_25)]">
                    {item.ano && <span>{item.ano}</span>}
                    {item.nota > 0 && <span className="flex items-center gap-1 text-[oklch(0.8_0.14_88)]"><Star size={12} fill="currentColor" /> {item.nota.toFixed(1)}</span>}
                    <span>{item.disponivel ? "Disponível" : "Indisponível"}</span>
                  </div>
                </div>
                <ChevronRight size={20} className="mr-2 shrink-0 text-[oklch(0.48_0.01_25)] transition-transform duration-200 ease-out group-hover:translate-x-1 group-hover:text-white" />
              </Link>
            );
          })}
        </div>

        {filtered.length === 0 && (
          <div className="py-24 text-center">
            <p className="font-semibold">Nenhum título encontrado</p>
            <p className="mt-1 text-sm text-[oklch(0.58_0.01_25)]">Ajuste o gênero, o ano ou o título buscado.</p>
          </div>
        )}
      </section>

      <section className="mx-auto mt-14 max-w-7xl border-t border-[oklch(0.28_0.009_25/0.65)] pt-8">
        <div className="px-6 md:px-12">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[oklch(0.62_0.16_28)]">Premiações</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight md:text-3xl">Títulos que fizeram história</h2>
        </div>
        <AwardRow
          title="Filmes com mais Oscars"
          description="Títulos disponíveis no catálogo, em ordem pelo número de estatuetas conquistadas."
          unit="Oscar"
          items={oscarItems}
        />
        <AwardRow
          title="Séries mais premiadas no Emmy"
          description="Produções disponíveis no catálogo, organizadas pelo total de prêmios Emmy."
          unit="Emmy"
          items={emmyItems}
        />
      </section>
    </main>
  );
}
