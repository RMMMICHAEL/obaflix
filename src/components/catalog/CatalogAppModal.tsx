"use client";

import { useEffect, useId, useRef } from "react";
import { Monitor, Smartphone, Tv, X } from "lucide-react";
import { INSTALADORES, type Instalador } from "@/config/downloads";

/**
 * "Assista no aplicativo Obaflix" — o convite de download que aparece quando
 * alguém clica em Assistir (ou num episódio) numa ficha de catálogo pelo
 * navegador comum.
 *
 * O streaming web está fechado; esta tela substitui o antigo redirect silencioso
 * para a landing. A ficha continua inteira por trás: o modal só abre depois de
 * uma ação explícita, nunca ao chegar do Google.
 *
 * Os endereços vêm de `@/config/downloads` (R2, servidos direto — nada passa
 * pela Vercel). Nenhuma URL é escrita aqui. Segue o padrão de acessibilidade do
 * `CastAppModal`: fecha no Escape, no clique fora e no X, trava o scroll, e
 * devolve o foco a quem abriu.
 */

export type AquisicaoPayload = {
  /** Nome do conteúdo. Filme: o título. Série: o título da série. */
  titulo: string;
  /** Contexto da ação: "Filme", "Temporada 1, Episódio 3" etc. */
  contexto?: string | null;
  /** Poster/backdrop já resolvido (URL completa), quando houver. Decorativo. */
  poster?: string | null;
};

type Plataforma = {
  chave: string;
  icone: React.ReactNode;
  nome: string;
  instalador: Instalador;
};

const PLATAFORMAS: Plataforma[] = [
  { chave: "android", icone: <Smartphone size={18} />, nome: "Android", instalador: INSTALADORES.android },
  { chave: "android-tv", icone: <Tv size={18} />, nome: "Android TV", instalador: INSTALADORES.androidTv },
  { chave: "windows", icone: <Monitor size={18} />, nome: "Windows", instalador: INSTALADORES.windows },
];

function BotaoPlataforma({ plataforma }: { plataforma: Plataforma }) {
  const { instalador, nome, icone } = plataforma;
  const pronto = instalador.url.length > 0;
  const detalhe = [instalador.versao, instalador.tamanho].filter(Boolean).join(" · ");

  if (!pronto) {
    return (
      <span className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-white/20 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white/45">
        <span className="flex items-center gap-2.5">
          {icone}
          {nome}
        </span>
        <span className="text-xs">Em preparação</span>
      </span>
    );
  }

  return (
    <a
      href={instalador.url}
      rel="noopener nofollow"
      className="flex items-center justify-between gap-3 rounded-xl bg-white px-4 py-3 text-sm font-bold text-zinc-950 transition-colors hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 active:scale-[0.99]"
    >
      <span className="flex items-center gap-2.5">
        {icone}
        Baixar para {nome}
      </span>
      {detalhe ? <span className="text-xs font-medium text-zinc-500">{detalhe}</span> : null}
    </a>
  );
}

export function CatalogAppModal({
  payload,
  onFechar,
}: {
  payload: AquisicaoPayload;
  onFechar: () => void;
}) {
  const tituloId = useId();
  const descricaoId = useId();
  const fecharRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const abridor = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFechar();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    // O foco entra no modal para o teclado e o leitor de tela irem junto.
    fecharRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      abridor?.focus?.();
    };
  }, [onFechar]);

  const subtitulo = [payload.titulo, payload.contexto].filter(Boolean).join(" — ");

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/80 p-4 backdrop-blur-sm sm:items-center"
      onClick={onFechar}
      role="dialog"
      aria-modal="true"
      aria-labelledby={tituloId}
      aria-describedby={descricaoId}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={tituloId} className="min-w-0 text-base font-bold leading-snug text-white sm:text-lg">
            Assista no aplicativo Obaflix
          </h2>
          <button
            ref={fecharRef}
            type="button"
            onClick={onFechar}
            aria-label="Fechar"
            className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
          >
            <X size={18} />
          </button>
        </div>

        {subtitulo ? (
          <p className="mt-1 truncate text-sm font-medium text-zinc-400" title={subtitulo}>
            {subtitulo}
          </p>
        ) : null}

        <p id={descricaoId} className="mt-3 text-sm leading-relaxed text-zinc-300">
          Este conteúdo está disponível no aplicativo Obaflix. Escolha seu dispositivo
          para baixar e começar a assistir.
        </p>

        <div className="mt-5 flex flex-col gap-2">
          {PLATAFORMAS.map((p) => (
            <BotaoPlataforma key={p.chave} plataforma={p} />
          ))}
        </div>

        <button
          type="button"
          onClick={onFechar}
          className="mt-3 w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-zinc-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
        >
          Agora não
        </button>
      </div>
    </div>
  );
}
