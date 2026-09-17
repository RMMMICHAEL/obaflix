"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { efeitoDoConvite, type FinalidadeDeAcao } from "@/lib/ads/acaoPatrocinada";
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
 * React; o que cada botão do convite faz vive em `src/lib/ads/acaoPatrocinada.ts`.
 * Aqui fica só o que precisa de DOM: abrir o Direct Link, chamar a ponte nativa,
 * esperar o usuário escolher e navegar para os planos.
 *
 * ## Desistir não é erro
 *
 * `AnuncioRecusado` existe para quem chama distinguir "deu problema" de "o
 * usuário não quis ver anúncio". O segundo caso volta ao estado anterior em
 * silêncio; tratar os dois igual mostraria uma tela de erro a quem simplesmente
 * mudou de ideia.
 *
 * ## Concluído, a ação continua sozinha
 *
 * Nenhum botão depois do anúncio. Assim que o SDK avisa o fim (Android), ou
 * passa o tempo do Direct Link (Electron), a promessa resolve e a ação original
 * — reproduzir, baixar ou transmitir — segue sem clique extra.
 */
export class AnuncioRecusado extends Error {
  constructor() {
    super("anuncio recusado pelo usuario");
    this.name = "AnuncioRecusado";
  }
}

/**
 * O servidor exige anúncio e não há meio de exibi-lo nesta plataforma.
 *
 * Electron sem `ANUNCIO_DIRECT_LINK_URL` configurada, ou navegador comum. É
 * estado do sistema, não do usuário — e é por isso que tem classe própria: a
 * mensagem fala de indisponibilidade temporária, não de erro nem de recusa.
 *
 * A sessão de fontes **não** é aberta. Ela recusaria de qualquer forma (é a
 * autoridade final e não há concessão), e o usuário veria "não foi possível
 * carregar os servidores" — um erro genérico para uma causa que sabemos qual é.
 */
export class AnuncioIndisponivel extends Error {
  constructor() {
    super("sem meio de exibir anuncio nesta plataforma");
    this.name = "AnuncioIndisponivel";
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

interface PonteDesktop {
  openSponsoredLink?: (url: string) => Promise<{ opened?: boolean; returned?: boolean }>;
}

declare global {
  interface Window {
    obaflixAds?: PonteDeAnuncioAndroid;
    obaflixDesktop?: PonteDesktop;
    /** Resolvida pelo nativo quando o anúncio fecha. Ver `AdsScript`. */
    __obaflixAnuncioConcluido?: (desafioId: string, concluido: boolean) => void;
  }
}

/** O que o modal está pedindo agora. */
type EstadoDoModal =
  | { fase: "oculto" }
  /** Antes de exibir: "assista a um anúncio para liberar esta ação". */
  | { fase: "convite"; finalidade: FinalidadeDeAcao }
  /** Electron: o link abriu no navegador; a ação continua ao fim da contagem. */
  | { fase: "aguardando"; segundosRestantes: number }
  /** Android: o SDK está exibindo. Quem fecha o anúncio é o próprio anúncio. */
  | { fase: "exibindo" };

/**
 * Quanto tempo o Electron espera antes de continuar a ação.
 *
 * Maior que o mínimo do servidor (6 s) de propósito: se fosse igual, a conclusão
 * chegaria no instante exato e seria recusada por arredondamento de relógio. A
 * margem faz a recusa do servidor ser um caso de automação, não de azar.
 */
const ESPERA_ELECTRON_S = 9;

/** O texto do convite, pela ação que o anúncio vai liberar. */
export function textoDoConvite(finalidade: FinalidadeDeAcao): string {
  switch (finalidade) {
    case "download":
      return "Veja um anúncio rápido para liberar este download.";
    case "transmissao":
      return "Veja um anúncio rápido para transmitir este título.";
    default:
      return "Veja um anúncio rápido para começar a reprodução.";
  }
}

export function useAnuncio() {
  const router = useRouter();
  const [modal, setModal] = useState<EstadoDoModal>({ fase: "oculto" });

  /** Resolve a promessa que `exibirAnuncio` está aguardando. */
  const resolverRef = useRef<((r: ResultadoDaExibicao) => void) | null>(null);
  const aceitarRef = useRef<(() => void) | null>(null);
  const limparRef = useRef<(() => void) | null>(null);
  /** O último cancelamento foi para escolher um plano: quem chamou não deve navegar por cima. */
  const foiAssinarRef = useRef(false);

  const encerrar = useCallback((concluido: boolean) => {
    limparRef.current?.();
    limparRef.current = null;
    aceitarRef.current = null;
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setModal({ fase: "oculto" });
    resolver?.({ concluido });
  }, []);

  const exibirAnuncio = useCallback(
    (entrada: {
      plataforma: PlataformaDeAnuncio;
      desafioId: string;
      directLink?: string;
      finalidade?: FinalidadeDeAcao;
    }) =>
      new Promise<ResultadoDaExibicao>((resolve) => {
        foiAssinarRef.current = false;
        resolverRef.current = resolve;
        setModal({ fase: "convite", finalidade: entrada.finalidade ?? "reproducao" });

        // O convite fica esperando a escolha; quem continua é `aoConfirmar`.
        aceitarRef.current = async () => {
          if (entrada.plataforma === "android") {
            const ponte = window.obaflixAds;
            const capability = ponte?.capability;
            if (!ponte?.mostrarAnuncio || !capability) {
              // Aplicativo antigo, sem a ponte: não há como exibir anúncio. Não
              // travar o usuário por uma versão que ele não escolheu — cancela,
              // e o servidor continua recusando a ação sem concessão.
              encerrar(false);
              return;
            }
            setModal({ fase: "exibindo" });
            // O nativo chama isto quando o anúncio fecha. O `desafioId` volta
            // junto para uma callback tardia de outro pedido não ser aceita.
            window.__obaflixAnuncioConcluido = (desafioId, concluido) => {
              if (desafioId !== entrada.desafioId) return;
              window.__obaflixAnuncioConcluido = undefined;
              // Concluído, a ação original continua sozinha: nenhum clique extra.
              encerrar(concluido === true);
            };
            ponte.mostrarAnuncio(capability, entrada.desafioId);
            return;
          }

          // Electron confirma pelo IPC que o sistema aceitou abrir exatamente o
          // link homologado. Depois aguardamos a janela perder e recuperar foco;
          // a validação de tempo e a concessão continuam no servidor.
          const ponte = window.obaflixDesktop;
          if (!entrada.directLink || !ponte?.openSponsoredLink) {
            encerrar(false);
            return;
          }
          setModal({ fase: "aguardando", segundosRestantes: ESPERA_ELECTRON_S });
          const abertura: { opened?: boolean; returned?: boolean } = await ponte
            .openSponsoredLink(entrada.directLink)
            .catch(() => ({ opened: false }));
          if (abertura?.opened !== true || abertura?.returned !== true) {
            encerrar(false);
            return;
          }

          let restantes = ESPERA_ELECTRON_S;
          const timer = setInterval(() => {
            restantes -= 1;
            if (restantes <= 0) {
              clearInterval(timer);
              limparRef.current = null;
              encerrar(true);
              return;
            }
            setModal({ fase: "aguardando", segundosRestantes: restantes });
          }, 1000);
          limparRef.current = () => clearInterval(timer);
        };
      }),
    [encerrar],
  );

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

  /** "Assistir anúncio". A única escolha que exibe. */
  const aoConfirmar = useCallback(() => {
    if (!efeitoDoConvite("assistir").exibirAnuncio) return;
    aceitarRef.current?.();
  }, []);

  /** X: fecha e cancela só a ação pendente. Nenhuma rota é chamada. */
  const aoFechar = useCallback(() => {
    window.__obaflixAnuncioConcluido = undefined;
    encerrar(false);
  }, [encerrar]);

  /** "Assinar um plano": cancela a ação pendente ANTES de navegar para a escolha. */
  const aoAssinar = useCallback(() => {
    const efeito = efeitoDoConvite("assinar");
    foiAssinarRef.current = true;
    window.__obaflixAnuncioConcluido = undefined;
    encerrar(false);
    if (efeito.navegarPara) router.push(efeito.navegarPara);
  }, [encerrar, router]);

  /** Se o último cancelamento foi para ir aos planos. */
  const saiuParaPlanos = useCallback(() => foiAssinarRef.current, []);

  return {
    portas: portas.current as PortasDoFluxo,
    modal,
    aoConfirmar,
    aoFechar,
    aoAssinar,
    saiuParaPlanos,
    executarFluxoDeAnuncio,
  };
}

/** O modal. Sem nome de rede, sem URL, sem parâmetro — só o que o usuário precisa. */
export function ModalDeAnuncio(props: {
  estado: EstadoDoModal;
  aoConfirmar: () => void;
  aoFechar: () => void;
  aoAssinar: () => void;
}) {
  const { estado, aoConfirmar, aoFechar, aoAssinar } = props;
  if (estado.fase === "oculto") return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-do-anuncio"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 px-6"
    >
      <div className="relative w-full max-w-sm rounded-xl border border-white/10 bg-[#101318] p-6 text-center">
        <button
          type="button"
          onClick={aoFechar}
          aria-label="Fechar"
          className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
        >
          <X size={18} aria-hidden="true" />
        </button>

        {estado.fase === "convite" && (
          <>
            <h2 id="titulo-do-anuncio" className="px-8 text-lg font-bold text-white">
              Continue assistindo gratuitamente
            </h2>
            <p className="mt-2 text-sm text-gray-400">
              Os anúncios ajudam a pagar os servidores. {textoDoConvite(estado.finalidade)}
            </p>
            <button
              type="button"
              onClick={aoConfirmar}
              className="mt-5 w-full rounded-full bg-white py-3 text-sm font-bold text-black"
            >
              Continuar gratuitamente
            </button>
            <button
              type="button"
              onClick={aoAssinar}
              className="mt-2 w-full rounded-full border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/10"
            >
              Ver planos e remover anúncios
            </button>
          </>
        )}

        {estado.fase === "exibindo" && (
          <p id="titulo-do-anuncio" className="py-4 text-sm text-gray-300">
            Carregando anúncio…
          </p>
        )}

        {estado.fase === "aguardando" && (
          <>
            <h2 id="titulo-do-anuncio" className="px-8 text-lg font-bold text-white">
              Anúncio aberto no navegador
            </h2>
            <p className="mt-2 text-sm text-gray-400">
              {estado.segundosRestantes > 0
                ? `Continuamos sozinhos em ${estado.segundosRestantes}s.`
                : "Volte ao Obaflix para continuar."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
