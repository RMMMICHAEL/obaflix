"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Download, Scissors, Layers, Lock, X } from "lucide-react";
import { LinkAssinatura } from "@/components/ui/LinkAssinatura";

/**
 * Escolha do tipo de download no player do Electron.
 *
 * Só apresenta: quem decide é o servidor (`direitosDoCliente`/`downloadPermitido`),
 * e cada ação volta a ser conferida no player e em POST /api/player/fontes.
 */
interface Props {
  titulo: string;
  subtitulo?: string;
  imagem?: string;
  podeCompleto: boolean;
  /** O download completo passa por anúncio (plano gratuito com anúncio ligado). */
  anuncio: boolean;
  podeIndividual: boolean;
  podeLote: boolean;
  onCompleto: () => void;
  onIndividual: () => void;
  onLote: () => void;
  onClose: () => void;
}

const BENEFICIOS = [
  { plano: "Cortes Start", itens: ["Cortes individuais"] },
  { plano: "Cortes Pro", itens: ["Cortes individuais", "Cortes em lote"] },
  { plano: "Cortes AI", itens: ["Tudo do Pro", "IA: ainda não disponível"] },
];

function Opcao({ icone, titulo, descricao, liberado, exigencia, acao, onAcao }: {
  icone: ReactNode; titulo: string; descricao: string; liberado: boolean;
  exigencia: string; acao: string; onAcao: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 ${liberado ? "border-white/10 bg-white/[0.04]" : "border-white/5 bg-white/[0.02]"}`}>
      <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${liberado ? "bg-white/10 text-white" : "bg-white/5 text-white/40"}`}>
        {icone}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-semibold ${liberado ? "text-white" : "text-white/60"}`}>{titulo}</p>
        <p className="text-xs leading-snug text-white/50">{liberado ? descricao : exigencia}</p>
      </div>
      {liberado ? (
        <button
          onClick={onAcao}
          className="flex-shrink-0 rounded-full bg-white px-4 py-2 text-xs font-semibold text-black transition-colors hover:bg-white/85"
        >
          {acao}
        </button>
      ) : (
        <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-white/5 px-3 py-1.5 text-[11px] text-white/50">
          <Lock size={12} aria-hidden /> Bloqueado
        </span>
      )}
    </div>
  );
}

export function DownloadModal(p: Props) {
  const tituloId = useId();
  const primeiroRef = useRef<HTMLButtonElement>(null);
  const { onClose } = p;
  const algumBloqueado = !p.podeCompleto || !p.podeIndividual || !p.podeLote;

  useEffect(() => {
    primeiroRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        className="relative max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative h-36 overflow-hidden">
          {p.imagem && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.imagem} alt="" className="h-full w-full object-cover" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />
          <button
            ref={primeiroRef}
            onClick={onClose}
            aria-label="Fechar"
            className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/80"
          >
            <X size={18} aria-hidden />
          </button>
          <div className="absolute bottom-3 left-5 right-5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-white/60">Baixar</p>
            <h2 id={tituloId} className="truncate text-lg font-bold text-white">{p.titulo}</h2>
            {p.subtitulo && <p className="truncate text-xs text-white/60">{p.subtitulo}</p>}
          </div>
        </div>

        <div className="space-y-2 px-5 pb-2 pt-3">
          <Opcao
            icone={<Download size={18} aria-hidden />}
            titulo="Conteúdo completo"
            descricao={p.anuncio ? "Um anúncio é exibido antes do download." : "O título inteiro no seu computador."}
            liberado={p.podeCompleto}
            exigencia="Seu plano atual não inclui download completo."
            acao={p.anuncio ? "Continuar com anúncios" : "Baixar"}
            onAcao={p.onCompleto}
          />
          <Opcao
            icone={<Scissors size={18} aria-hidden />}
            titulo="Trecho individual"
            descricao="Escolha início e fim e baixe só a cena."
            liberado={p.podeIndividual}
            exigencia="Disponível nos planos Cortes Start, Pro e AI."
            acao="Escolher trecho"
            onAcao={p.onIndividual}
          />
          <Opcao
            icone={<Layers size={18} aria-hidden />}
            titulo="Vários trechos (lote)"
            descricao="Monte uma lista de cenas e baixe tudo de uma vez."
            liberado={p.podeLote}
            exigencia="Disponível nos planos Cortes Pro e AI."
            acao="Montar lote"
            onAcao={p.onLote}
          />
        </div>

        {algumBloqueado && (
          <div className="mx-5 mb-5 mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="mb-3 text-xs font-semibold text-white/80">Planos Obaflix Cortes</p>
            <div className="grid grid-cols-3 gap-2">
              {BENEFICIOS.map((b) => (
                <div key={b.plano}>
                  <p className="text-[11px] font-semibold text-white">{b.plano}</p>
                  <ul className="mt-1 space-y-0.5">
                    {b.itens.map((i) => <li key={i} className="text-[11px] leading-snug text-white/50">{i}</li>)}
                  </ul>
                </div>
              ))}
            </div>
            <LinkAssinatura
              href="/planos"
              className="mt-4 block w-full rounded-full bg-[#E50914] py-2.5 text-center text-sm font-semibold text-white transition-colors hover:bg-[#f6121d]"
            >
              Conhecer planos
            </LinkAssinatura>
          </div>
        )}
        {!algumBloqueado && <div className="h-3" />}
      </div>
    </div>
  );
}
