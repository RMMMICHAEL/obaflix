"use client";

import { useEffect } from "react";
import { Loader2, X } from "lucide-react";

export type Qualidade = { id: string; label: string; altura: number };

/**
 * Escolha da qualidade antes de baixar.
 *
 * ## Por que existe
 *
 * Sem ela o aplicativo escolheria sozinho a maior variante do manifesto — o
 * arquivo maior, sempre, para todo mundo. Num plano de dados limitado ou num
 * aparelho com pouco espaco, isso e a decisao errada tomada em silencio.
 *
 * ## O que a lista pode conter
 *
 * Somente o que o manifesto declarou. As opcoes vem de `RESOLUTION` das
 * variantes `#EXT-X-STREAM-INF` lidas pelo lado nativo; quando a fonte nao
 * declara resolucao — MP4, ou HLS sem master — chega uma opcao unica "Padrão".
 * Nada aqui deduz qualidade a partir de bitrate ou de nome de servidor.
 *
 * Segue o padrao do `TrailerModal`: fecha no Escape, no clique fora e no X, e
 * trava o scroll do documento enquanto esta aberto.
 */
export function DownloadQualityModal({
  titulo,
  qualidades,
  ocupado,
  onEscolher,
  onFechar,
}: {
  titulo: string;
  qualidades: Qualidade[];
  /** Enquanto o pedido esta indo para o lado nativo. */
  ocupado: boolean;
  onEscolher: (q: Qualidade) => void;
  onFechar: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFechar();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onFechar]);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/80 p-4 backdrop-blur-sm sm:items-center"
      onClick={onFechar}
      role="dialog"
      aria-modal="true"
      aria-label="Escolha a qualidade do download"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="min-w-0 text-base font-bold leading-snug text-white sm:text-lg">
            {titulo}
          </h2>
          <button
            type="button"
            onClick={onFechar}
            aria-label="Fechar"
            className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mt-1.5 text-sm text-zinc-400">Escolha a qualidade que deseja baixar.</p>

        <div className="mt-5 flex flex-col gap-2">
          {qualidades.map((q) => (
            <button
              key={q.id}
              type="button"
              disabled={ocupado}
              onClick={() => onEscolher(q)}
              className="flex h-12 items-center justify-between rounded-xl border border-white/10 bg-white/[0.06] px-4 text-[15px] font-semibold text-zinc-100 transition-colors hover:border-white/25 hover:bg-white/[0.14] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>{q.label}</span>
              {/* A altura so aparece quando o manifesto a declarou; em "Padrão"
                  ela e zero e nada e mostrado, em vez de um rotulo inventado. */}
              {q.altura > 0 && (
                <span className="text-xs font-medium tabular-nums text-zinc-500">
                  {q.altura}px
                </span>
              )}
            </button>
          ))}
        </div>

        {ocupado && (
          <p className="mt-4 flex items-center justify-center gap-2 text-sm text-zinc-400">
            <Loader2 size={15} className="animate-spin" /> Iniciando download…
          </p>
        )}
      </div>
    </div>
  );
}
