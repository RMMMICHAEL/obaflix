"use client";

import { useCallback, useRef, useState } from "react";

import {
  executarFluxoDeAnuncio,
  type PlataformaDeAnuncio,
  type PortasDoFluxo,
  type ResultadoDaExibicao,
} from "@/lib/ads/fluxoDoCliente";

/**
 * O fluxo de anúncio ligado à interface: as portas concretas e o modal.
 *
 * A sequência em si vive em `src/lib/ads/fluxoDoCliente.ts` e é testada lá, sem
 * React. Aqui fica só o que precisa de DOM: abrir o Direct Link, chamar a ponte
 * nativa, e esperar o usuário clicar.
 *
 * ## Desistir não é erro
 *
 * `AnuncioRecusado` existe para o player distinguir "deu problema" de "o usuário
 * não quis ver anúncio". O segundo caso volta ao catálogo em silêncio; tratar os
 * dois igual mostraria uma tela de erro a quem simplesmente mudou de ideia.
 */
export class AnuncioRecusado extends Error {
  constructor() {
    super("anuncio recusado pelo usuario");
    this.name = "AnuncioRecusado";
  }
}

/**
 * A superfície nativa do Android, quando existe.
 *
 * Mínima de propósito: uma função, que recebe o `capability` da sessão e o
 * `desafioId` que o **servidor** emitiu. Não é acesso genérico do WebView ao
 * nativo — é esta capacidade e mais nada, no mesmo modelo que a ponte do
 * aplicativo já usa.
 */
interface PonteDeAnuncioAndroid {
  capability?: string;
  mostrarAnuncio?: (capability: string, desafioId: string) => void;
}

declare global {
  interface Window {
    obaflixAds?: PonteDeAnuncioAndroid;
    /** Resolvida pelo nativo quando o anúncio fecha. Ver `AdGateScript`. */
    __obaflixAnuncioConcluido?: (desafioId: string, concluido: boolean) => void;
  }
}

/** O que o modal está pedindo agora. */
type EstadoDoModal =
  | { fase: "oculto" }
  /** Antes de exibir: "assista a um anúncio para liberar". */
  | { fase: "convite" }
  /** Electron: o link abriu no navegador e estamos esperando o usuário voltar. */
  | { fase: "aguardando"; segundosRestantes: number }
  /** Android: o SDK está exibindo. Sem botão — quem fecha é o anúncio. */
  | { fase: "exibindo" };

/**
 * Quanto tempo o botão de liberar fica desabilitado no Electron.
 *
 * Maior que o mínimo do servidor (6 s) de propósito: se fosse igual, um usuário
 * clicando no instante exato seria recusado por arredondamento de relógio e
 * veria um erro sem entender por quê. A margem faz a recusa do servidor ser um
 * caso de automação, não de azar.
 */
const ESPERA_ELECTRON_S = 9;

export function useAnuncio() {
  const [modal, setModal] = useState<EstadoDoModal>({ fase: "oculto" });

  /** Resolve a promessa que `exibirAnuncio` está aguardando. */
  const resolverRef = useRef<((r: ResultadoDaExibicao) => void) | null>(null);

  const encerrar = useCallback((concluido: boolean) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setModal({ fase: "oculto" });
    resolver?.({ concluido });
  }, []);

  const exibirAnuncio = useCallback(
    (entrada: { plataforma: PlataformaDeAnuncio; desafioId: string; directLink?: string }) =>
      new Promise<ResultadoDaExibicao>((resolve) => {
        resolverRef.current = resolve;
        setModal({ fase: "convite" });

        // O convite fica esperando o clique; quem continua é `aceitar`, abaixo.
        aceitarRef.current = () => {
          if (entrada.plataforma === "android") {
            const ponte = window.obaflixAds;
            const capability = ponte?.capability;
            if (!ponte?.mostrarAnuncio || !capability) {
              // Aplicativo antigo, sem a ponte: não há como exibir anúncio. Não
              // travar o usuário por uma versão que ele não escolheu — cancela,
              // e o servidor continua recusando a sessão sem concessão.
              encerrar(false);
              return;
            }
            setModal({ fase: "exibindo" });
            // O nativo chama isto quando o anúncio fecha. O `desafioId` volta
            // junto para uma callback tardia de outro pedido não ser aceita.
            window.__obaflixAnuncioConcluido = (desafioId, concluido) => {
              if (desafioId !== entrada.desafioId) return;
              window.__obaflixAnuncioConcluido = undefined;
              encerrar(concluido === true);
            };
            ponte.mostrarAnuncio(capability, entrada.desafioId);
            return;
          }

          // Electron: `window.open` é interceptado por `setWindowOpenHandler` no
          // main, que só abre `https:` via `shell.openExternal`. Nenhuma ponte
          // nova, nenhum `nodeIntegration`, nenhum relaxamento de
          // `contextIsolation` — o caminho já existia para links externos.
          if (entrada.directLink) window.open(entrada.directLink, "_blank", "noopener,noreferrer");

          let restantes = ESPERA_ELECTRON_S;
          setModal({ fase: "aguardando", segundosRestantes: restantes });
          const timer = setInterval(() => {
            restantes -= 1;
            if (restantes <= 0) {
              clearInterval(timer);
              setModal({ fase: "aguardando", segundosRestantes: 0 });
              return;
            }
            setModal({ fase: "aguardando", segundosRestantes: restantes });
          }, 1000);
          limparRef.current = () => clearInterval(timer);
        };
      }),
    [encerrar],
  );

  const aceitarRef = useRef<(() => void) | null>(null);
  const limparRef = useRef<(() => void) | null>(null);

  const portas = useRef<Pick<PortasDoFluxo, "autorizar" | "concluir" | "exibirAnuncio">>({
    async autorizar(pedido) {
      const res = await fetch("/api/playback/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pedido),
      });
      if (!res.ok) throw new Error("autorizacao indisponivel");
      return res.json();
    },
    async concluir(entrada) {
      const res = await fetch("/api/ads/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entrada),
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      return typeof data?.concessao === "string" ? data.concessao : null;
    },
    exibirAnuncio,
  });
  portas.current.exibirAnuncio = exibirAnuncio;

  const aoConfirmar = useCallback(() => {
    aceitarRef.current?.();
  }, []);

  const aoCancelar = useCallback(() => {
    limparRef.current?.();
    limparRef.current = null;
    window.__obaflixAnuncioConcluido = undefined;
    encerrar(false);
  }, [encerrar]);

  const aoLiberar = useCallback(() => {
    limparRef.current?.();
    limparRef.current = null;
    encerrar(true);
  }, [encerrar]);

  return {
    portas: portas.current as PortasDoFluxo,
    modal,
    aoConfirmar,
    aoCancelar,
    aoLiberar,
    executarFluxoDeAnuncio,
  };
}

/** O modal. Sem nome de rede, sem URL, sem parâmetro — só o que o usuário precisa. */
export function ModalDeAnuncio(props: {
  estado: EstadoDoModal;
  aoConfirmar: () => void;
  aoCancelar: () => void;
  aoLiberar: () => void;
}) {
  const { estado, aoConfirmar, aoCancelar, aoLiberar } = props;
  if (estado.fase === "oculto") return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 px-6">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#101318] p-6 text-center">
        {estado.fase === "convite" && (
          <>
            <h2 className="text-lg font-bold text-white">Assista a um anúncio</h2>
            <p className="mt-2 text-sm text-gray-400">
              Seu plano libera a reprodução depois de um anúncio rápido.
            </p>
            <button
              onClick={aoConfirmar}
              className="mt-5 w-full rounded-full bg-white py-3 text-sm font-bold text-black"
            >
              Assistir anúncio
            </button>
            <button onClick={aoCancelar} className="mt-2 w-full py-2 text-sm text-gray-400">
              Agora não
            </button>
          </>
        )}

        {estado.fase === "exibindo" && (
          <p className="py-4 text-sm text-gray-300">Carregando anúncio…</p>
        )}

        {estado.fase === "aguardando" && (
          <>
            <h2 className="text-lg font-bold text-white">Anúncio aberto no navegador</h2>
            <p className="mt-2 text-sm text-gray-400">
              Volte aqui quando terminar para liberar a reprodução.
            </p>
            <button
              onClick={aoLiberar}
              disabled={estado.segundosRestantes > 0}
              className="mt-5 w-full rounded-full bg-white py-3 text-sm font-bold text-black disabled:opacity-40"
            >
              {estado.segundosRestantes > 0
                ? `Aguarde ${estado.segundosRestantes}s…`
                : "Liberar reprodução"}
            </button>
            <button onClick={aoCancelar} className="mt-2 w-full py-2 text-sm text-gray-400">
              Cancelar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
