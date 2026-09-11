"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Tv } from "lucide-react";
import type { ItemDeCanal } from "@/lib/canais/catalogo";
import { CardDeCanal } from "./CardDeCanal";
import { PlayerDeCanal } from "./PlayerDeCanal";

/**
 * A tela de canais do app (Android em WebView) e do Electron.
 *
 * Um componente para os dois porque os dois consomem o mesmo React. Não existe
 * produto para navegador comum nesta fase, e esta rota não é um lançamento de
 * site: ela vive dentro dos aplicativos.
 *
 * ## O filtro acontece aqui, a permissão não
 *
 * Categoria e busca filtram a lista **em memória**, sobre o que o servidor já
 * devolveu — e o que o servidor devolveu é só o que esta conta pode abrir. O
 * recorte por entitlement é feito na consulta, em `/api/canais`, e por isso não
 * existe card bloqueado nesta tela: o que a conta não alcança não chega aqui.
 *
 * Buscar em memória evita uma requisição por tecla digitada. São dezenas de
 * canais — a lista cabe numa resposta e o filtro é instantâneo.
 */

interface Categoria {
  id: string;
  rotulo: string;
}

interface Resposta {
  canais: ItemDeCanal[];
  categorias: Categoria[];
}

type Estado =
  | { fase: "carregando" }
  | { fase: "pronto"; dados: Resposta }
  | { fase: "erro"; precisaLogin: boolean };

/**
 * Normaliza para a busca ignorar acento e caixa.
 *
 * `NFD` separa a letra do acento, e a classe abaixo é a faixa `U+0300–U+036F`,
 * o bloco de sinais diacríticos combinantes. Os dois extremos são caracteres
 * combinantes de verdade, então no editor eles aparecem grudados no colchete —
 * é esperado, e não uma corrupção do arquivo.
 */
function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function GradeDeCanais() {
  const [estado, setEstado] = useState<Estado>({ fase: "carregando" });
  const [categoria, setCategoria] = useState("todos");
  const [busca, setBusca] = useState("");
  const [aberto, setAberto] = useState<ItemDeCanal | null>(null);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let vivo = true;
    setEstado({ fase: "carregando" });
    fetch("/api/canais", { headers: { Accept: "application/json" } })
      .then(async (r) => {
        if (!vivo) return;
        if (r.status === 401) {
          setEstado({ fase: "erro", precisaLogin: true });
          return;
        }
        if (!r.ok) {
          setEstado({ fase: "erro", precisaLogin: false });
          return;
        }
        setEstado({ fase: "pronto", dados: (await r.json()) as Resposta });
      })
      .catch(() => {
        if (vivo) setEstado({ fase: "erro", precisaLogin: false });
      });
    return () => {
      vivo = false;
    };
  }, [tentativa]);

  const visiveis = useMemo(() => {
    if (estado.fase !== "pronto") return [];
    const termo = normalizar(busca.trim());
    return estado.dados.canais.filter(
      (c) =>
        (categoria === "todos" || c.categoria === categoria) &&
        (termo === "" || normalizar(c.nome).includes(termo)),
    );
  }, [estado, categoria, busca]);

  // ── Estados ────────────────────────────────────────────────────────────────

  if (estado.fase === "carregando") {
    return (
      <Moldura>
        <div
          className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6"
          aria-busy="true"
          aria-label="Carregando canais"
        >
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-[8.5rem] animate-pulse rounded-xl bg-zinc-900" />
          ))}
        </div>
      </Moldura>
    );
  }

  if (estado.fase === "erro") {
    return (
      <Moldura>
        <Vazio
          titulo={estado.precisaLogin ? "Entre para ver os canais" : "Não foi possível carregar"}
          detalhe={
            estado.precisaLogin
              ? "Os canais ao vivo fazem parte da sua conta."
              : "Verifique sua conexão e tente de novo."
          }
          acao={
            estado.precisaLogin
              ? { rotulo: "Entrar", href: "/login" }
              : { rotulo: "Tentar de novo", aoClicar: () => setTentativa((n) => n + 1) }
          }
        />
      </Moldura>
    );
  }

  const { categorias, canais } = estado.dados;

  if (canais.length === 0) {
    return (
      <Moldura>
        <Vazio titulo="Nenhum canal disponível" detalhe="Os canais ao vivo voltam em breve." />
      </Moldura>
    );
  }

  return (
    <>
      <Moldura>
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar canal"
            aria-label="Buscar canal"
            className="w-full bg-transparent py-3 text-sm text-white placeholder-zinc-500 outline-none"
          />
        </div>

        {/* Chips. Rolagem horizontal sem barra: no retrato as onze categorias
            não cabem, e quebrar em duas linhas comeria a altura da grade. */}
        <div
          className="mb-4 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Categorias"
        >
          {categorias.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={categoria === c.id}
              onClick={() => setCategoria(c.id)}
              className={`shrink-0 rounded-full px-4 py-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
                categoria === c.id
                  ? "bg-red-600 text-white"
                  : "border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {c.rotulo}
            </button>
          ))}
        </div>

        {visiveis.length === 0 ? (
          <Vazio
            titulo={busca.trim() ? "Nenhum canal encontrado" : "Categoria vazia"}
            detalhe={
              busca.trim()
                ? `Nada corresponde a “${busca.trim()}”.`
                : "Nenhum canal nesta categoria agora."
            }
            acao={
              busca.trim()
                ? { rotulo: "Limpar busca", aoClicar: () => setBusca("") }
                : { rotulo: "Ver todos", aoClicar: () => setCategoria("todos") }
            }
          />
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {visiveis.map((canal) => (
              <CardDeCanal key={canal.id} canal={canal} onAbrir={setAberto} />
            ))}
          </div>
        )}
      </Moldura>

      {aberto && <PlayerDeCanal canal={aberto} onFechar={() => setAberto(null)} />}
    </>
  );
}

function Moldura({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
      <h1 className="mb-4 text-xl font-black tracking-tight text-white">Canais ao vivo</h1>
      {children}
    </div>
  );
}

function Vazio({
  titulo,
  detalhe,
  acao,
}: {
  titulo: string;
  detalhe: string;
  acao?: { rotulo: string; href?: string; aoClicar?: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-14 text-center">
      <Tv className="h-10 w-10 text-zinc-700" aria-hidden />
      <p className="text-sm font-semibold text-zinc-200">{titulo}</p>
      <p className="max-w-xs text-xs text-zinc-500">{detalhe}</p>
      {acao?.href && (
        <a
          href={acao.href}
          className="mt-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
        >
          {acao.rotulo}
        </a>
      )}
      {acao?.aoClicar && (
        <button
          type="button"
          onClick={acao.aoClicar}
          className="mt-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
        >
          {acao.rotulo}
        </button>
      )}
    </div>
  );
}
