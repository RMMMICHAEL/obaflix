"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Radio, Search, Tv } from "lucide-react";
import type { ItemDeCanal } from "@/lib/canais/catalogo";
import { PlayerDeCanal, type AcoesDoPlayerDeCanal } from "./PlayerDeCanal";
import { ModalDeAnuncio, useAnuncio } from "@/components/player/useAnuncio";
import { criarSelecaoMaisRecente } from "@/lib/canais/selecaoMaisRecente";

/**
 * Tela de Canais ao Vivo (app em WebView e Electron).
 *
 * ## Layout lista + player
 *
 * O workspace começa **abaixo do header global** (`Navbar` é `fixed h-16`; as
 * páginas de conteúdo compensam com `pt-20`, e aqui é igual), com o título
 * "Canais ao vivo" dentro do conteúdo. Telas grandes (`lg`): a tela ocupa a
 * altura da janela; painel à esquerda (~30%: busca + categorias + lista, só a
 * lista rola) e o player à direita ocupando a coluna inteira — sem bloco de
 * programação/EPG abaixo. Telas estreitas: player 16:9 em cima, painel embaixo.
 *
 * Só existe UM `PlayerDeCanal` por vez — ao trocar de canal, `key={id}` desmonta
 * o anterior (o cleanup destrói hls, timers e listeners; o controle descarta a
 * resposta de um `/play` que ainda estava em voo) antes de montar o novo. Não
 * pré-resolve canal nenhum: `/play` só acontece para o canal selecionado. As
 * setas só movem o foco na lista; quem troca de canal é clique/Enter.
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

/** Grid principal: painel ~30% + player. Mesmo esqueleto no carregamento. */
const GRID =
  "flex min-h-0 flex-col gap-5 lg:grid lg:flex-1 lg:grid-cols-[minmax(300px,30%)_minmax(0,1fr)] lg:gap-6";
const PAINEL =
  "order-2 flex min-h-0 flex-col rounded-2xl border border-live-line/70 bg-live-surface p-3 md:p-4 lg:order-1";
const AREA_PLAYER =
  "relative order-1 aspect-video w-full overflow-hidden rounded-2xl border border-live-line/70 bg-black lg:order-2 lg:aspect-auto lg:h-full";

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
  const acoesDoPlayerRef = useRef<AcoesDoPlayerDeCanal | null>(null);
  /** Só a seleção mais recente efetiva estado e `/play` (ver `abrir`). */
  const [pedidos] = useState(criarSelecaoMaisRecente);

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

  /** Número estável do canal (posição no catálogo), independente do filtro. */
  const numeroDe = useMemo(() => {
    const m = new Map<string, number>();
    if (estado.fase === "pronto") estado.dados.canais.forEach((c, i) => m.set(c.id, i + 1));
    return m;
  }, [estado]);

  const rotuloDaCategoria = useMemo(() => {
    const m = new Map<string, string>();
    if (estado.fase === "pronto") estado.dados.categorias.forEach((c) => m.set(c.id, c.rotulo));
    return m;
  }, [estado]);

  // Mantém o cursor de teclado dentro do intervalo quando a lista visível muda.
  useEffect(() => {
    setFocado((f) => Math.min(Math.max(0, f), Math.max(0, visiveis.length - 1)));
  }, [visiveis.length]);

  async function abrir(canal: ItemDeCanal) {
    // Token desta abertura. Um clique mais novo invalida os anteriores: a
    // resposta atrasada de um canal já abandonado não reseleciona nem abre /play.
    const pedido = pedidos.iniciar();
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
    if (!pedidos.vale(pedido)) return;
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
        <div className={GRID} aria-busy="true">
          <div className={PAINEL}>
            <div className="mb-3 h-11 animate-pulse rounded-xl bg-live-raised" />
            <div className="mb-4 flex flex-wrap gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-8 w-20 animate-pulse rounded-full bg-live-raised" />
              ))}
            </div>
            <div className="flex flex-col gap-2">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-live-raised" />
              ))}
            </div>
          </div>
          <div className={`${AREA_PLAYER} animate-pulse`} />
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
        <div className={GRID}>
          {/* PAINEL: busca + categorias + lista (só a lista rola) */}
          <aside className={PAINEL} aria-label="Canais">
            <label className="mb-3 flex shrink-0 items-center gap-3 rounded-xl border border-live-line bg-live-raised px-4 transition focus-within:border-white/25">
              <Search className="h-4 w-4 shrink-0 text-live-muted" aria-hidden />
              <input
                type="search"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar canal..."
                aria-label="Buscar canal"
                className="w-full bg-transparent py-3 text-sm text-white placeholder-live-muted outline-none"
              />
            </label>

            <div className="mb-4 flex shrink-0 flex-wrap gap-2" role="tablist" aria-label="Categorias">
              {categorias.map((c) => {
                const ativo = categoria === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={ativo}
                    onClick={() => setCategoria(c.id)}
                    className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${
                      ativo
                        ? "border-live-glow bg-live-accent text-white shadow-[0_0_16px_rgba(229,9,20,0.35)]"
                        : "border-live-line bg-live-raised text-zinc-200 hover:border-white/20 hover:text-white"
                    }`}
                  >
                    {c.rotulo}
                  </button>
                );
              })}
            </div>

            {visiveis.length === 0 ? (
              <Vazio
                compacto
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
                className="scrollbar-live -mr-1 flex max-h-[55vh] min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-0.5 pr-2 pl-0.5 lg:max-h-none"
              >
                {visiveis.map((canal, i) => (
                  <LinhaDeCanal
                    key={canal.id}
                    canal={canal}
                    numero={numeroDe.get(canal.id) ?? i + 1}
                    subtitulo={rotuloDaCategoria.get(canal.categoria) ?? ""}
                    selecionado={selecionado?.id === canal.id}
                    refBotao={(el) => {
                      linhasRef.current[i] = el;
                    }}
                    aoFocar={() => setFocado(i)}
                    aoAbrir={(peloTeclado) => {
                      setFocado(i);
                      // Enter no canal que já está tocando expande em tela cheia.
                      if (peloTeclado && selecionado?.id === canal.id) {
                        acoesDoPlayerRef.current?.alternarTelaCheia();
                        return;
                      }
                      void abrir(canal);
                    }}
                  />
                ))}
              </div>
            )}
          </aside>

          {/* PLAYER: ocupa a coluna inteira; o vídeo mantém a proporção. */}
          <section className={AREA_PLAYER} aria-label="Player">
            {selecionado ? (
              <PlayerDeCanal
                key={selecionado.id}
                canal={selecionado}
                inline
                concessaoAnuncio={concessaoAnuncio}
                acoesRef={acoesDoPlayerRef}
                onFechar={() => setSelecionado(null)}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(ellipse_at_center,rgba(229,9,20,0.08),transparent_60%)] px-6 text-center">
                <div className="flex flex-col items-center gap-3">
                  <span className="grid h-16 w-16 place-items-center rounded-full border border-live-line bg-live-surface">
                    <Radio className="h-7 w-7 text-live-accent" aria-hidden />
                  </span>
                  <p className="text-base font-semibold text-white">Selecione um canal</p>
                  <p className="max-w-xs text-sm text-live-muted">
                    Escolha um canal na lista para assistir ao vivo.
                  </p>
                </div>
              </div>
            )}
          </section>
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
  numero,
  subtitulo,
  selecionado,
  aoAbrir,
  aoFocar,
  refBotao,
}: {
  canal: ItemDeCanal;
  numero: number;
  subtitulo: string;
  selecionado: boolean;
  /** `peloTeclado` = ativado por Enter/Espaço (e.detail === 0), não por clique. */
  aoAbrir: (peloTeclado: boolean) => void;
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
      onClick={(e) => aoAbrir(e.detail === 0)}
      onFocus={aoFocar}
      className={`group flex min-h-[64px] w-full shrink-0 items-center gap-3 rounded-xl border px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${
        selecionado
          ? "border-live-glow/90 bg-[linear-gradient(90deg,rgba(229,9,20,0.20),rgba(229,9,20,0.06))] shadow-[0_0_0_1px_rgba(242,13,36,0.35),0_0_22px_rgba(242,13,36,0.28)]"
          : "border-live-line/70 bg-live-raised hover:border-white/20 hover:bg-[#171a21]"
      }`}
    >
      <span className="w-8 shrink-0 text-center text-xs tabular-nums text-live-muted">
        {String(numero).padStart(3, "0")}
      </span>
      <span className="flex h-11 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/40 px-1">
        {mostrarLogo ? (
          // Logo de terceiro, tamanho imprevisível: `<img>` com `object-contain`.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={canal.logoUrl ?? ""}
            alt=""
            loading="lazy"
            onError={() => setLogoFalhou(true)}
            className="max-h-9 max-w-full object-contain"
          />
        ) : (
          <Tv className="h-5 w-5 text-zinc-600" aria-hidden />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold text-white">{canal.nome}</span>
        {subtitulo && <span className="truncate text-xs text-live-muted">{subtitulo}</span>}
      </span>
      {selecionado && (
        <span className="flex shrink-0 items-center gap-1 rounded-md bg-live-accent px-2 py-1 text-[10px] font-bold leading-none text-white shadow-[0_0_12px_rgba(242,13,36,0.45)]">
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
    // conteúdo começa ABAIXO do header global, nunca atrás dele. Em `lg` a tela
    // ocupa exatamente a janela, para o player preencher a coluna sem rolagem.
    <div className="mx-auto flex w-full max-w-[1800px] flex-col px-4 pt-20 pb-6 md:px-10 lg:h-[100dvh]">
      <header className="mb-5 flex shrink-0 items-center gap-3 md:mb-6 md:gap-4">
        <Radio className="h-7 w-7 shrink-0 text-live-accent drop-shadow-[0_0_10px_rgba(242,13,36,0.55)] md:h-9 md:w-9" aria-hidden />
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold leading-tight tracking-tight text-white md:text-4xl">
            Canais ao vivo
          </h1>
          <p className="mt-0.5 text-sm text-live-muted md:text-base">
            Assista seus canais favoritos em tempo real.
          </p>
        </div>
      </header>
      {children}
    </div>
  );
}

function Vazio({
  titulo,
  detalhe,
  acao,
  compacto = false,
}: {
  titulo: string;
  detalhe: string;
  acao?: { rotulo: string; href?: string; aoClicar?: () => void };
  compacto?: boolean;
}) {
  const botao =
    "mt-1 rounded-lg bg-live-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-live-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80";
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-2xl border border-live-line/70 bg-live-surface px-6 text-center ${
        compacto ? "py-10" : "py-14"
      }`}
    >
      <Tv className="h-10 w-10 text-zinc-700" aria-hidden />
      <p className="text-sm font-semibold text-zinc-200">{titulo}</p>
      <p className="max-w-xs text-xs text-live-muted">{detalhe}</p>
      {acao?.href && (
        <a href={acao.href} className={botao}>
          {acao.rotulo}
        </a>
      )}
      {acao?.aoClicar && (
        <button type="button" onClick={acao.aoClicar} className={botao}>
          {acao.rotulo}
        </button>
      )}
    </div>
  );
}
