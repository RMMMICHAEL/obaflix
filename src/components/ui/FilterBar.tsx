"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, Search, X } from "lucide-react";

interface Genero { id: number; nome: string; }

interface FilterBarProps {
  generos: Genero[];
  anos: number[];
  total?: number;
  pages?: number;
  label: string;
}

const ORDENS = [
  { value: "recente", label: "Mais Recentes" },
  { value: "antigo",  label: "Mais Antigos" },
  { value: "nota",    label: "Melhor Avaliados" },
  { value: "popular", label: "Mais Populares" },
  { value: "az",      label: "A — Z" },
];

export function FilterBar({ generos, anos, total, pages = 0, label }: FilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [searchVal, setSearchVal] = useState(searchParams.get("q") ?? "");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const genero = searchParams.get("genero");
  const ano = searchParams.get("ano");
  const ordem = searchParams.get("ordem");
  const q = searchParams.get("q");
  const page = Number(searchParams.get("page") ?? 1);
  const hasFilters = !!(genero || ano || ordem || q);

  const update = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value); else params.delete(key);
      params.delete("page");
      startTransition(() => router.push(`${pathname}?${params.toString()}`));
    },
    [router, pathname, searchParams],
  );

  const goToPage = useCallback(
    (p: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(p));
      startTransition(() => router.push(`${pathname}?${params.toString()}`));
    },
    [router, pathname, searchParams],
  );

  const clearAll = useCallback(() => {
    setSearchVal("");
    if (searchTimer.current) clearTimeout(searchTimer.current);
    startTransition(() => router.push(pathname));
  }, [router, pathname]);

  useEffect(() => {
    setSearchVal(q ?? "");
  }, [q]);

  const onSearchChange = (val: string) => {
    setSearchVal(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => update("q", val || null), 500);
  };

  const ordemLabel = ORDENS.find((o) => o.value === ordem)?.label;
  const generoLabel = generos.find((g) => String(g.id) === genero)?.nome;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/35 pointer-events-none" />
          <input
            type="text"
            value={searchVal}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={`Buscar ${label}...`}
            className="pl-9 pr-8 py-2 rounded-full bg-white/[0.06] border border-white/[0.12] text-sm text-white placeholder-white/30 focus:outline-none focus:border-red-500/50 focus:bg-white/[0.09] transition-colors w-52"
          />
          {searchVal && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/35 hover:text-white transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <FilterDropdown
          label="Ordenar"
          activeLabel={ordemLabel}
          paramKey="ordem"
          options={ORDENS}
          current={ordem}
          openKey={openKey}
          setOpenKey={setOpenKey}
          onSelect={(v) => update("ordem", v)}
        />

        <FilterDropdown
          label="Gênero"
          activeLabel={generoLabel}
          paramKey="genero"
          options={generos.map((g) => ({ value: String(g.id), label: g.nome }))}
          current={genero}
          openKey={openKey}
          setOpenKey={setOpenKey}
          onSelect={(v) => update("genero", v)}
          scrollable
        />

        <FilterDropdown
          label="Ano"
          activeLabel={ano ?? undefined}
          paramKey="ano"
          options={anos.map((a) => ({ value: String(a), label: String(a) }))}
          current={ano}
          openKey={openKey}
          setOpenKey={setOpenKey}
          onSelect={(v) => update("ano", v)}
          scrollable
        />

        <div className="ml-auto flex items-center gap-3">
          {hasFilters && total !== undefined && (
            <span className={`text-sm text-white/45 transition-opacity ${isPending ? "opacity-30" : ""}`}>
              {total} {label}
            </span>
          )}
          {hasFilters && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-white/55 hover:text-white border border-white/[0.12] hover:border-white/25 transition-colors"
            >
              <X className="w-3 h-3" />
              Limpar
            </button>
          )}
        </div>
      </div>

      {pages > 1 && hasFilters && (
        <div className="flex items-center justify-center gap-3 mt-10">
          <button
            onClick={() => goToPage(page - 1)}
            disabled={page <= 1}
            className="px-5 py-2 rounded-lg text-sm font-medium border border-white/[0.12] text-white/65 hover:text-white hover:border-white/25 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
          >
            ← Anterior
          </button>
          <span className="text-white/35 text-sm tabular-nums">
            {page} / {pages}
          </span>
          <button
            onClick={() => goToPage(page + 1)}
            disabled={page >= pages}
            className="px-5 py-2 rounded-lg text-sm font-medium border border-white/[0.12] text-white/65 hover:text-white hover:border-white/25 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
          >
            Próxima →
          </button>
        </div>
      )}
    </div>
  );
}

interface DropdownProps {
  label: string;
  activeLabel?: string;
  paramKey: string;
  options: { value: string; label: string }[];
  current: string | null;
  openKey: string | null;
  setOpenKey: (k: string | null) => void;
  onSelect: (v: string | null) => void;
  scrollable?: boolean;
}

function FilterDropdown({
  label, activeLabel, paramKey, options, current,
  openKey, setOpenKey, onSelect, scrollable,
}: DropdownProps) {
  const isOpen = openKey === paramKey;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpenKey(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, setOpenKey]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpenKey(isOpen ? null : paramKey)}
        className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium border transition-colors
          ${current
            ? "border-red-500/50 text-red-400 bg-red-500/[0.08]"
            : "border-white/[0.12] text-white/65 hover:text-white hover:border-white/25 bg-white/[0.04]"
          }`}
      >
        {activeLabel || label}
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div
          className={`absolute top-full mt-2 left-0 bg-zinc-950 border border-white/[0.08] rounded-xl py-1.5 min-w-[160px] z-50 shadow-2xl shadow-black/60
            ${scrollable ? "max-h-72 overflow-y-auto" : ""}`}
        >
          <button
            onClick={() => { onSelect(null); setOpenKey(null); }}
            className="w-full text-left px-4 py-2 text-sm text-white/35 hover:text-white hover:bg-white/[0.05] transition-colors"
          >
            Todos
          </button>
          <div className="h-px bg-white/[0.06] my-1" />
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { onSelect(opt.value); setOpenKey(null); }}
              className={`w-full text-left px-4 py-2 text-sm transition-colors hover:bg-white/[0.05]
                ${opt.value === current ? "text-red-400 font-medium" : "text-white/70 hover:text-white"}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
