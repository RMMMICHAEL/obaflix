"use client";

import { Suspense, useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { LandscapeCard } from "@/components/ui/LandscapeCard";
import {
  avancarFonte,
  fonteZerada,
  intercalar,
  proximaPagina,
  temMais as aindaTemMais,
  totalCombinado,
  type EstadoFonte,
} from "@/lib/pagination";

const ORDENS = [
  { value: "recente", label: "Mais Recente" },
  { value: "popular", label: "Mais Populares" },
  { value: "nota", label: "Melhor Nota" },
  { value: "az", label: "A-Z" },
];

function GeneroConteudo() {
  const params = useParams();
  const generoId = params.id as string;

  const [nomeGenero, setNomeGenero] = useState<string>("");
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [temMais, setTemMais] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ordem, setOrdem] = useState("recente");

  // Cursor fora do estado de render: `load` precisa da posicao atual sem
  // depender de closure, e mudar de pagina nao deve, por si, redesenhar nada.
  // A aritmetica em si vive em @/lib/pagination, testada fora do React.
  const cursor = useRef<{ filmes: EstadoFonte; series: EstadoFonte }>({
    filmes: fonteZerada(),
    series: fonteZerada(),
  });

  const load = useCallback(
    async (reset: boolean, ord: string) => {
      if (reset) cursor.current = { filmes: fonteZerada(), series: fonteZerada() };

      const paginaFilmes = proximaPagina(cursor.current.filmes);
      const paginaSeries = proximaPagina(cursor.current.series);
      if (paginaFilmes === null && paginaSeries === null) return;

      setLoading(true);
      try {
        // So pede a fonte que ainda tem o que dar.
        const [filmesData, seriesData] = await Promise.all([
          paginaFilmes === null
            ? null
            : fetch(`/api/filmes?page=${paginaFilmes}&genero=${generoId}&ordem=${ord}`)
                .then((r) => r.json())
                .catch(() => null),
          paginaSeries === null
            ? null
            : fetch(`/api/series?page=${paginaSeries}&genero=${generoId}&ordem=${ord}`)
                .then((r) => r.json())
                .catch(() => null),
        ]);

        const filmes = (filmesData?.filmes ?? []).map((f: any) => ({ ...f, tipo: "filme" as const }));
        const series = (seriesData?.series ?? []).map((s: any) => ({ ...s, tipo: s.tipo ?? "serie" }));

        if (filmesData) {
          cursor.current.filmes = avancarFonte(cursor.current.filmes, filmes.length, filmesData.total);
        }
        if (seriesData) {
          cursor.current.series = avancarFonte(cursor.current.series, series.length, seriesData.total);
        }

        // O nome do genero vem do primeiro item que realmente carrega o id
        // pedido — nao do primeiro item da lista, que depois da expansao das
        // equivalencias filme/TV pode ter vindo pelo id irmao.
        if (!nomeGenero) {
          for (const item of [...filmes, ...series]) {
            const encontrado = item.generos?.find((g: any) => String(g.genero.id) === generoId);
            if (encontrado) { setNomeGenero(encontrado.genero.nome); break; }
          }
        }

        const merged = intercalar(filmes, series);

        setItems((prev) => (reset ? merged : [...prev, ...merged]));
        setTotal(totalCombinado(cursor.current.filmes, cursor.current.series));
        setTemMais(aindaTemMais(cursor.current.filmes, cursor.current.series));
      } finally {
        setLoading(false);
      }
    },
    [generoId, nomeGenero],
  );

  useEffect(() => {
    setNomeGenero("");
    load(true, ordem);
    // `load` muda junto com nomeGenero e reexecutaria a carga a cada rotulo
    // encontrado; a dependencia real desta carga e a rota e a ordem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((item) => (
          <LandscapeCard
            key={`${item.tipo}-${item.id}`}
            layout="grid"
            id={item.id}
            tipo={item.tipo}
            titulo={item.titulo}
            poster={item.poster}
            background={item.background}
            logo={item.logo}
            ano={item.ano}
            nota={item.nota}
          />
        ))}
      </div>

      {temMais && (
        <div className="flex justify-center mt-8">
          <button
            onClick={() => load(false, ordem)}
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
