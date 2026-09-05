"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import { Search, X } from "lucide-react";
import { rotaDeBusca } from "@/components/layout/androidNav";

export const dynamic = "force-dynamic";

type Aba = "tudo" | "filme" | "serie" | "anime";

function BuscarConteudo() {
  const sp = useSearchParams();
  const router = useRouter();
  const q = sp.get("q") ?? "";

  // O campo espelha a querystring, mas e editavel: chegar aqui pela lupa, por
  // um link ou pelo botao voltar sempre deixa o termo visivel e pronto para ser
  // corrigido. Antes esta pagina nao tinha campo NENHUM — so lia `?q=` —, entao
  // a aba "Buscar" da barra inferior levava a uma tela sem como buscar.
  const [termo, setTermo] = useState(q);
  const [filmes, setFilmes] = useState<any[]>([]);
  const [series, setSeries] = useState<any[]>([]);
  const [aba, setAba] = useState<Aba>("tudo");
  const [loading, setLoading] = useState(false);

  useEffect(() => setTermo(q), [q]);

  useEffect(() => {
    if (!q) { setFilmes([]); setSeries([]); return; }
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((d) => { setFilmes(d.filmes ?? []); setSeries(d.series ?? []); })
      .finally(() => setLoading(false));
  }, [q]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const destino = rotaDeBusca(termo);
    if (!destino) return;
    router.push(destino);
  }

  const abas: { id: Aba; label: string }[] = [
    { id: "tudo", label: "Tudo" },
    { id: "filme", label: "Filmes" },
    { id: "serie", label: "Séries" },
    { id: "anime", label: "Animes" },
  ];

  const filmesVisiveis = aba === "tudo" || aba === "filme" ? filmes : [];
  const seriesVisiveis = aba === "tudo" ? series : aba === "serie" ? series.filter((s) => s.tipo === "serie") : aba === "anime" ? series.filter((s) => s.tipo === "anime") : [];
  const semResultado = !loading && q && filmesVisiveis.length === 0 && seriesVisiveis.length === 0;

  return (
    <div className="pt-20 px-4 md:px-8 pb-16 min-h-screen">
      <form onSubmit={submit} role="search" className="mb-6 max-w-2xl">
        <label htmlFor="busca-catalogo" className="sr-only">Buscar no catálogo</label>
        <div className="flex items-center gap-3 rounded-full bg-zinc-900 border border-white/10 px-4 h-12 focus-within:border-white/30 transition">
          <Search size={19} className="text-zinc-400 shrink-0" aria-hidden="true" />
          <input
            id="busca-catalogo"
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder="Filme, série, anime..."
            autoComplete="off"
            enterKeyHint="search"
            // Sem termo na URL, o usuario chegou aqui para digitar.
            autoFocus={!q}
            className="flex-1 min-w-0 bg-transparent text-white placeholder:text-zinc-500 outline-none text-[15px]"
          />
          {termo && (
            <button
              type="button"
              onClick={() => { setTermo(""); router.push("/buscar"); }}
              aria-label="Limpar busca"
              className="text-zinc-400 hover:text-white transition shrink-0"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </form>

      {q && (
        <h1 className="text-xl font-semibold text-white mb-5">
          Resultados para &ldquo;{q}&rdquo;
        </h1>
      )}

      {q && (
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
      )}

      {!q && (
        <p className="text-zinc-500 text-sm">
          Digite o nome de um filme, série ou anime para começar.
        </p>
      )}

      {loading && <p className="text-zinc-500 text-sm">Buscando...</p>}

      {semResultado && (
        <p className="text-zinc-500 text-sm">Nenhum resultado encontrado.</p>
      )}

      {filmesVisiveis.length > 0 && (
        <div className="mb-8">
          {aba === "tudo" && <h2 className="text-white font-semibold mb-3">Filmes</h2>}
          <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {filmesVisiveis.map((f) => (
              <LandscapeCard key={f.id} layout="grid" id={f.id} tipo="filme" titulo={f.titulo} poster={f.poster} background={f.background} logo={f.logo} ano={f.ano} nota={f.nota} />
            ))}
          </div>
        </div>
      )}

      {seriesVisiveis.length > 0 && (
        <div>
          {aba === "tudo" && <h2 className="text-white font-semibold mb-3">Séries</h2>}
          <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {seriesVisiveis.map((s) => (
              <LandscapeCard key={s.id} layout="grid" id={s.id} tipo={s.tipo} titulo={s.titulo} poster={s.poster} background={s.background} logo={s.logo} ano={s.ano} nota={s.nota} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BuscarPage() {
  return (
    <Suspense fallback={<div className="pt-20 px-8 text-zinc-500 text-sm">Carregando...</div>}>
      <BuscarConteudo />
    </Suspense>
  );
}
