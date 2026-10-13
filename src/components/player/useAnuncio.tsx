"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

import { efeitoDoConvite, type FinalidadeDeAcao } from "@/lib/ads/acaoPatrocinada";
import { criarContagemAndroid } from "@/lib/ads/contagemAndroid";
import { segundosRestantesAnuncio } from "@/lib/ads/tempoAnuncio";
import { ehClientePlayNoNavegador, rotaAoAssinar } from "@/config/play";
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
  rewardedProtocol?: string;
  configurar?: (capability: string, config: string) => void;
  mostrarBanner?: (capability: string) => void;
  ocultarBanner?: (capability: string) => void;
  privacidade?: (capability: string) => void;
  mostrarRewarded?: (capability: string, desafioId: string) => void;
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
    __obaflixAnuncioConcluido?: (desafioId: string, concluido: boolean, motivo?: string) => void;
  }
}

/** O que o modal está pedindo agora. */
type EstadoDoModal =
  | { fase: "oculto" }
  /**
   * Antes de exibir: "assista a um anúncio para liberar esta ação".
   *
   * `plataforma` decide a interação: no Electron o usuário clica para continuar;
   * no Android não há clique obrigatório — o convite conta `contagem` segundos e
   * chama a ponte nativa sozinho.
   */
  | { fase: "convite"; plataforma: PlataformaDeAnuncio; finalidade: FinalidadeDeAcao; contagem?: number }
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

  const encerrar = useCallback((concluido: boolean, motivo?: "indisponivel") => {
    limparRef.current?.();
    limparRef.current = null;
    aceitarRef.current = null;
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setModal({ fase: "oculto" });
    resolver?.({ concluido, ...(motivo ? { motivo } : {}) });
  }, []);

  useEffect(() => () => {
    limparRef.current?.();
    resolverRef.current?.({ concluido: false });
    resolverRef.current = null;
    aceitarRef.current = null;
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
        const finalidade = entrada.finalidade ?? "reproducao";

        // O convite fica esperando: no Electron, a escolha do usuário; no
        // Android, o fim da contagem. Os dois caminhos chamam `aceitarRef`.
        aceitarRef.current = async () => {
          aceitarRef.current = null;
          if (entrada.plataforma === "android") {
            const ponte = window.obaflixAds;
            const capability = ponte?.capability;
            const mostrar = ehClientePlayNoNavegador() ? ponte?.mostrarRewarded : ponte?.mostrarAnuncio;
            if (!mostrar || !capability) {
              // Aplicativo antigo, sem a ponte: não há como exibir anúncio. Não
              // travar o usuário por uma versão que ele não escolheu — cancela,
              // e o servidor continua recusando a ação sem concessão.
              encerrar(false, "indisponivel");
              return;
            }
            const config = await fetch("/api/ads/config", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);
            if (resolverRef.current !== resolve) return;
            const enabled = ehClientePlayNoNavegador() ? config?.rewarded : config?.interstitial;
            if (!enabled || !config?.placements?.includes("playback") || config?.sessionCap <= 0) {
              encerrar(false, "indisponivel");
              return;
            }
            ponte?.configurar?.(capability, JSON.stringify(config));
            setModal({ fase: "exibindo" });
            // O nativo chama isto quando o anúncio fecha. O `desafioId` volta
            // junto para uma callback tardia de outro pedido não ser aceita.
            window.__obaflixAnuncioConcluido = (desafioId, concluido, motivo) => {
              if (desafioId !== entrada.desafioId) return;
              window.__obaflixAnuncioConcluido = undefined;
              // Concluído, a ação original continua sozinha: nenhum clique extra.
              encerrar(concluido === true, !concluido && motivo !== "CANCELLED" ? "indisponivel" : undefined);
            };
            const timeout = setTimeout(() => {
              window.__obaflixAnuncioConcluido = undefined;
              encerrar(false, "indisponivel");
            }, 240_000);
            limparRef.current = () => clearTimeout(timeout);
            mostrar(capability, entrada.desafioId);
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
          const prazo = Date.now() + ESPERA_ELECTRON_S * 1000;
          let retornoConfirmado = false;
          let esperaConcluida = false;
          const atualizarContagem = () => {
            if (resolverRef.current !== resolve) return;
            const restantes = segundosRestantesAnuncio(prazo);
            setModal({ fase: "aguardando", segundosRestantes: restantes });
            if (restantes === 0) {
              esperaConcluida = true;
              limparRef.current?.();
              limparRef.current = null;
              if (retornoConfirmado) encerrar(true);
            }
          };
          setModal({ fase: "aguardando", segundosRestantes: ESPERA_ELECTRON_S });
          const timer = setInterval(atualizarContagem, 250);
          limparRef.current = () => clearInterval(timer);
          const abertura: { opened?: boolean; returned?: boolean } = await ponte
            .openSponsoredLink(entrada.directLink)
            .catch(() => ({ opened: false }));
          // O retorno do navegador pode chegar depois de cancelar/sair ou de
          // abrir outro convite. Ele só pode concluir a promessa que o abriu.
          if (resolverRef.current !== resolve) return;
          if (abertura?.opened !== true || abertura?.returned !== true) {
            encerrar(false);
            return;
          }
          retornoConfirmado = true;
          atualizarContagem();
          if (esperaConcluida && resolverRef.current === resolve) encerrar(true);
        };

        if (entrada.plataforma !== "android") {
          // Electron (e qualquer plataforma que não seja Android): o convite
          // espera o clique em "Continuar gratuitamente". Fluxo inalterado.
          setModal({ fase: "convite", plataforma: entrada.plataforma, finalidade });
          return;
        }

        if (ehClientePlayNoNavegador()) {
          setModal({ fase: "convite", plataforma: "android", finalidade });
          return;
        }

        // APK direto: mantém o convite comercial legado.
        // Android: nenhum clique obrigatório. O convite abre contando 3 s e, ao
        // zerar, chama a ponte nativa sozinho (via `aceitarRef`). A contagem em
        // si — disparo único, pausa em segundo plano, encerramento — vive em
        // `contagemAndroid` e é testada lá; aqui só se liga ao relógio real, à
        // visibilidade da página e ao texto do modal.
        const temDocumento = typeof document !== "undefined";
        const contagem = criarContagemAndroid({
          agora: () => Date.now(),
          visivel: () => !temDocumento || document.visibilityState === "visible",
          aoZerar: () => {
            // Limpa o próprio timer antes de exibir: `aceitarRef` troca a fase
            // para "exibindo" e não deve concorrer com mais nenhuma passada.
            limparRef.current?.();
            limparRef.current = null;
            // A concessão continua dependendo do callback nativo + servidor; os
            // 3 s só abrem o anúncio, não liberam nada por si.
            aceitarRef.current?.();
          },
        });
        setModal({
          fase: "convite",
          plataforma: "android",
          finalidade,
          contagem: contagem.segundosRestantes(),
        });
        const aoMudarVisibilidade = () => {
          if (document.visibilityState === "visible") contagem.marcarVisivel();
        };
        if (temDocumento) document.addEventListener("visibilitychange", aoMudarVisibilidade);
        const timer = setInterval(() => {
          contagem.avancar();
          // `avancar` pode ter disparado e trocado a fase para "exibindo"; só
          // atualiza o texto enquanto ainda for o convite desta promessa.
          if (resolverRef.current !== resolve) return;
          const seg = contagem.segundosRestantes();
          setModal((m) => (m.fase === "convite" ? { ...m, contagem: seg } : m));
        }, 200);
        limparRef.current = () => {
          clearInterval(timer);
          if (temDocumento) document.removeEventListener("visibilitychange", aoMudarVisibilidade);
          contagem.encerrar();
        };
      }),
    [encerrar],
  );

  const portas = useRef<Pick<PortasDoFluxo, "autorizar" | "concluir" | "exibirAnuncio">>({
    async autorizar(pedido) {
      const res = await fetch("/api/playback/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(ehClientePlayNoNavegador() && window.obaflixAds?.rewardedProtocol === "levelplay-v1"
          ? { headers: { "Content-Type": "application/json", "x-obaflix-rewarded": "levelplay-v1" } } : {}),
        body: JSON.stringify(pedido),
      });
      if (!res.ok) throw new Error("autorizacao indisponivel");
      return res.json();
    },
    async concluir(entrada) {
      if (ehClientePlayNoNavegador()) {
        // O callback Android é somente um sinal para consultar a prova S2S.
        for (let tentativa = 0; tentativa < 12; tentativa++) {
          const res = await fetch("/api/ads/levelplay/status", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ desafioId: entrada.desafioId }),
          });
          if (!res.ok) return null;
          const data = await res.json().catch(() => null);
          if (data?.state === "verified" && typeof data.concessao === "string") return data.concessao;
          if (data?.state !== "pending") return null;
          await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** tentativa, 2500)));
        }
        return null;
      }
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

  /**
   * "Assinar um plano": cancela a ação pendente ANTES de navegar para a escolha.
   *
   * No Play a navegação é fail-closed: cancela/limpa como sempre, mas NUNCA vai
   * para rota comercial (`rotaAoAssinar` devolve null). Os CTAs comerciais já
   * ficam escondidos no Play; isto é defesa extra caso um reapareça por engano.
   * Fora do Play o comportamento é idêntico ao de antes.
   */
  const aoAssinar = useCallback(() => {
    const efeito = efeitoDoConvite("assinar");
    foiAssinarRef.current = true;
    window.__obaflixAnuncioConcluido = undefined;
    encerrar(false);
    const destino = rotaAoAssinar(ehClientePlayNoNavegador(), efeito.navegarPara);
    if (destino) router.push(destino);
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

  // Google Play é consumo apenas: o convite de anúncio continua (o streaming é
  // gratuito/por anúncio), mas sem nenhum CTA que leve a assinar/remover
  // anúncios — isso é compra, e a loja proíbe fora do seu sistema. Só esconde
  // o botão comercial; nada do fluxo de anúncio em si muda.
  const play = ehClientePlayNoNavegador();

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

        {estado.fase === "convite" && estado.plataforma === "android" && !play && (
          // Android: sem clique obrigatório. O convite conta sozinho e o X só
          // cancela a ação — nunca concede acesso. A concessão continua no
          // callback nativo + servidor.
          <>
            <h2 id="titulo-do-anuncio" className="px-8 text-lg font-bold text-white">
              Seu conteúdo começa após o anúncio
            </h2>
            <p className="mt-3 text-2xl font-bold text-white" role="status" aria-live="polite">
              Anúncio em {estado.contagem ?? 3}
            </p>
            {/* Secundário, abaixo da contagem: reaproveita exatamente o mesmo
                `aoAssinar` do convite Electron — encerra timer/listeners (via
                `encerrar`), não chama a ponte nem concede acesso, e navega aos
                planos. Nenhuma rota ou lógica de pagamento nova. Escondido no
                Play, onde não há compra. */}
            {!play && (
              <button
                type="button"
                onClick={aoAssinar}
                className="mt-5 text-sm font-medium text-gray-400 underline underline-offset-4 hover:text-white"
              >
                Remover anúncios
              </button>
            )}
          </>
        )}

        {estado.fase === "convite" && (estado.plataforma !== "android" || play) && (
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
              {play ? "Assistir anúncio e continuar" : "Continuar gratuitamente"}
            </button>
            {!play && (
              <button
                type="button"
                onClick={aoAssinar}
                className="mt-2 w-full rounded-full border border-white/15 py-3 text-sm font-semibold text-white hover:bg-white/10"
              >
                Ver planos e remover anúncios
              </button>
            )}
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
