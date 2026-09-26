"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Tv } from "lucide-react";
import type { ItemDeCanal } from "@/lib/canais/catalogo";
import { PlayerDeCanal } from "./PlayerDeCanal";
import { ModalDeAnuncio, useAnuncio } from "@/components/player/useAnuncio";

/**
 * Tela de Canais ao Vivo (app em WebView e Electron).
 *
 * ## Layout lista + preview (Etapa 3)
 *
 * O workspace começa **abaixo do header global** (`Navbar` é `fixed h-16`; as
 * páginas de conteúdo compensam com `pt-20`, e aqui é igual) e é centralizado
 * (`max-w-7xl mx-auto`). Telas grandes: sidebar à esquerda (~32%) com busca +
 * categorias + lista (só a lista rola), e preview grande à direita, 16:9,
 * centralizada verticalmente na área abaixo do header. Telefone: preview em cima
 * (largura total), depois busca/categorias/lista.
 *
 * Só existe UM `PlayerDeCanal` por vez — ao trocar de canal, `key={id}` desmonta
 * o anterior (o cleanup destrói hls, timers e listeners) antes de montar o novo.
 * Não pré-resolve canal nenhum: `/play` só acontece para o canal que realmente
 * entra em reprodução.
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

/** Normaliza para a busca ignorar acento e caixa. */
function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function GradeDeCanais() {
  const anuncio = useAnuncio();
  const [estado, setEstado] = useState<Estado>({ fase: "carregando" });
  const [categoria, setCategoria] = useState("todos");
  const [busca, setBusca] = useState("");
  const [selecionado, setSelecionado] = useState<ItemDeCanal | null>(null);
  const [focado, setFocado] = useState(0);
  const [concessaoAnuncio, setConcessaoAnuncio] = useState<string | null>(null);
  const [tentativa, setTentativa] = useState(0);
  const linhasRef = useRef<(HTMLButtonElement | null)[]>([]);

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

  // Mantém o cursor de teclado dentro do intervalo quando a lista visível muda.
  useEffect(() => {
    setFocado((f) => Math.min(Math.max(0, f), Math.max(0, visiveis.length - 1)));
  }, [visiveis.length]);

  async function abrir(canal: ItemDeCanal) {
    const desktop = typeof window !== "undefined" && !!window.obaflixDesktop;
    const android = typeof window !== "undefined" && !!window.obaflixAds;
    if (!desktop && !android) {
      setSelecionado(canal);
      return;
    }
    const fluxo = await anuncio.executarFluxoDeAnuncio(
      {
        conteudoId: canal.id,
        conteudoTipo: "canal",
        plataforma: desktop ? "electron" : "android",
        finalidade: "reproducao",
      },
      anuncio.portas,
    );
    if (fluxo.situacao === "liberado") {
      setConcessaoAnuncio(fluxo.concessao);
      setSelecionado(canal);
    }
  }

  function aoTeclarLista(e: React.KeyboardEvent<HTMLDivElement>) {
    if (visiveis.length === 0) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const n = Math.min(visiveis.length - 1, Math.max(0, focado + delta));
    setFocado(n);
    const el = linhasRef.current[n];
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }

  if (estado.fase === "carregando") {
    return (
      <Moldura>
        <div className="flex flex-col gap-4 lg:h-[calc(100vh-7rem)] lg:flex-row lg:gap-6">
          <div className="order-2 flex flex-col gap-2 lg:order-1 lg:w-[32%] lg:max-w-sm lg:shrink-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-zinc-900" />
            ))}
          </div>
          <div className="order-1 lg:order-2 lg:flex lg:h-full lg:flex-1 lg:items-center lg:justify-center">
            <div className="mx-auto aspect-video w-full animate-pulse rounded-xl bg-zinc-900 lg:max-w-[calc((100vh-7rem)*16/9)]" />
          </div>
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
        <div className="flex flex-col gap-4 lg:h-[calc(100vh-7rem)] lg:flex-row lg:gap-6">
          {/* SIDEBAR: busca + categorias + lista (só a lista rola) */}
          <aside className="order-2 flex min-h-0 flex-col lg:order-1 lg:h-full lg:w-[32%] lg:max-w-sm lg:shrink-0">
            <div className="mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3">
              <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
              <input
                type="search"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar canal"
                aria-label="Buscar canal"
                className="w-full bg-transparent py-2.5 text-sm text-white placeholder-zinc-500 outline-none"
              />
            </div>

            {/* Categorias dentro da própria sidebar (chips com wrap), nunca
                atravessando o topo da página. */}
            <div
              className="mb-3 flex shrink-0 flex-wrap gap-2"
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
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
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
              <div
                role="listbox"
                aria-label="Lista de canais"
                onKeyDown={aoTeclarLista}
                className="flex min-h-0 max-h-[45vh] flex-1 flex-col gap-1 overflow-y-auto pr-1 lg:max-h-none"
              >
                {visiveis.map((canal, i) => (
                  <LinhaDeCanal
                    key={canal.id}
                    canal={canal}
                    selecionado={selecionado?.id === canal.id}
                    refBotao={(el) => {
                      linhasRef.current[i] = el;
                    }}
                    aoFocar={() => setFocado(i)}
                    aoAbrir={() => {
                      setFocado(i);
                      void abrir(canal);
                    }}
                  />
                ))}
              </div>
            )}
          </aside>

          {/* PREVIEW: centralizada vertical/horizontalmente na área útil */}
          <main className="order-1 lg:order-2 lg:flex lg:h-full lg:flex-1 lg:items-center lg:justify-center">
            <div className="relative mx-auto aspect-video w-full overflow-hidden rounded-xl border border-zinc-800 bg-black lg:max-w-[calc((100vh-7rem)*16/9)]">
              {selecionado ? (
                <PlayerDeCanal
                  key={selecionado.id}
                  canal={selecionado}
                  inline
                  concessaoAnuncio={concessaoAnuncio}
                  onFechar={() => setSelecionado(null)}
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center px-6 text-center">
                  <div className="flex flex-col items-center gap-3">
                    <Tv className="h-10 w-10 text-zinc-700" aria-hidden />
                    <p className="text-sm font-semibold text-zinc-300">Selecione um canal</p>
                    <p className="max-w-xs text-xs text-zinc-500">
                      Escolha um canal na lista para assistir ao vivo, com áudio.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>
      </Moldura>

      <ModalDeAnuncio
        estado={anuncio.modal}
        aoConfirmar={anuncio.aoConfirmar}
        aoFechar={anuncio.aoFechar}
        aoAssinar={anuncio.aoAssinar}
      />
    </>
  );
}

function LinhaDeCanal({
  canal,
  selecionado,
  aoAbrir,
  aoFocar,
  refBotao,
}: {
  canal: ItemDeCanal;
  selecionado: boolean;
  aoAbrir: () => void;
  aoFocar: () => void;
  refBotao: (el: HTMLButtonElement | null) => void;
}) {
  const [logoFalhou, setLogoFalhou] = useState(false);
  const mostrarLogo = Boolean(canal.logoUrl) && !logoFalhou;

  return (
    <button
      ref={refBotao}
      type="button"
      role="option"
      aria-selected={selecionado}
      onClick={aoAbrir}
      onFocus={aoFocar}
      className={`flex w-full shrink-0 items-center gap-3 rounded-lg border px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
        selecionado
          ? "border-red-600 bg-red-600/15 text-white"
          : "border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800"
      }`}
    >
      <span className="flex h-8 w-12 shrink-0 items-center justify-center">
        {mostrarLogo ? (
          // Logo de terceiro, tamanho imprevisível: `<img>` com `object-contain`.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={canal.logoUrl ?? ""}
            alt=""
            loading="lazy"
            onError={() => setLogoFalhou(true)}
            className="max-h-8 max-w-full object-contain"
          />
        ) : (
          <Tv className="h-5 w-5 text-zinc-600" aria-hidden />
        )}
      </span>
      <span className="line-clamp-1 flex-1 text-sm font-medium">{canal.nome}</span>
      {selecionado && (
        <span className="flex shrink-0 items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
          AO VIVO
        </span>
      )}
    </button>
  );
}

function Moldura({ children }: { children: React.ReactNode }) {
  return (
    // `pt-20` = mesmo offset das demais páginas (Navbar é `fixed h-16`): o
    // conteúdo começa ABAIXO do header global, nunca atrás dele. Centralizado.
    <div className="mx-auto w-full max-w-7xl px-4 pt-20 pb-8">
      <h1 className="sr-only">Canais ao vivo</h1>
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
