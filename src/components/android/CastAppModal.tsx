"use client";

import { useEffect } from "react";
import { Cast, Download, Loader2, X } from "lucide-react";

/**
 * "Aplicativo necessário" — o Web Video Cast falta.
 *
 * ## Por que antes do anúncio
 *
 * A transmissão só existe com o app externo. Descobrir a falta dele **depois**
 * de a pessoa assistir a um anúncio e o servidor resolver a fonte era o defeito:
 * trabalho jogado fora e, no pior caso, um spinner que não terminava. Este modal
 * aparece antes de qualquer uma das duas coisas.
 *
 * ## Os dois botões
 *
 * - **Baixar aplicativo** — leva à ficha do Web Video Cast na loja. O modal
 *   **fica aberto**: a pessoa sai para a loja e volta ao Obaflix com ele já
 *   nesta tela, para tocar em Transmitir. Se nem a loja nem o navegador abrem
 *   (AOSP sem Play Store), uma mensagem curta aparece aqui mesmo.
 * - **Transmitir** — reconsulta se o app já está instalado. Se ainda falta, o
 *   modal continua; se chegou, fecha e a transmissão segue o fluxo normal
 *   (autorização/anúncio → resolução da fonte → app externo).
 *
 * Único para as duas origens (página do conteúdo e player): quem o desenha é o
 * `AndroidMediaActions`, que os dois lugares reaproveitam. Segue o
 * `DownloadQualityModal`: fecha no Escape, no clique fora e no X, e trava o
 * scroll enquanto está aberto.
 */
export function CastAppModal({
  erro,
  ocupado,
  onBaixar,
  onTransmitir,
  onFechar,
}: {
  /** Mensagem curta de falha (loja não abriu, ou app ainda ausente). */
  erro?: string | null;
  /** Enquanto a loja está sendo aberta. */
  ocupado?: boolean;
  onBaixar: () => void;
  onTransmitir: () => void;
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
      aria-label="Aplicativo necessário"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="min-w-0 text-base font-bold leading-snug text-white sm:text-lg">
            Aplicativo necessário
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

        <p className="mt-2 text-sm leading-relaxed text-zinc-300">
          Para transmitir, você precisa do aplicativo Web Video Cast. Baixe o
          aplicativo, volte ao Obaflix e toque em Transmitir.
        </p>

        {erro && (
          <p role="alert" className="mt-3 text-sm leading-snug text-red-400">
            {erro}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={ocupado}
            onClick={onBaixar}
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-4 text-[15px] font-semibold text-black transition-colors hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {ocupado ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Download size={18} strokeWidth={2} />
            )}
            Baixar aplicativo
          </button>
          <button
            type="button"
            disabled={ocupado}
            onClick={onTransmitir}
            className="flex h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-4 text-[15px] font-semibold text-zinc-100 transition-colors hover:border-white/25 hover:bg-white/[0.14] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Cast size={18} strokeWidth={2} />
            Transmitir
          </button>
        </div>
      </div>
    </div>
  );
}
