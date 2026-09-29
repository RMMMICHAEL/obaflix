"use client";

import { useEffect, useRef, useState } from "react";
import {
  ALTURA_DO_BANNER,
  SANDBOX_DO_BANNER,
  TEMPO_SEM_ANUNCIO_MS,
  alturaDoIframe,
  criarControleDeFalhas,
  lerMensagemDoBanner,
  urlDoBanner,
  type PosicaoDoBanner,
} from "@/lib/ads/bannerDesktop";

/**
 * Espaço publicitário do aplicativo Windows. Em qualquer outro ambiente não
 * renderiza nada e não faz requisição nenhuma.
 *
 * ## Portas, nesta ordem
 *
 *  1. **cliente** — `obaflixDesktop.isDesktop === true`. Só o preload do
 *     Electron (`contextBridge`) define isso; o shim do Android define
 *     `platform: "android"` e nunca `isDesktop`. Navegador comum e Android
 *     param aqui, sem fetch;
 *  2. **servidor** — `/api/ads/banner-desktop` decide pelo direito da conta
 *     (assinante pago não vê) e pela flag `ANUNCIO_BANNER_DESKTOP_ATIVO`;
 *  3. **tela cheia** — em tela cheia (do documento ou da janela nativa) o slot
 *     é desmontado; ao sair, volta com um documento novo.
 *
 * Mesmo que as portas falhassem num navegador, a CSP da web (`frame-src
 * 'none'` fora de `/assistir`) recusaria o iframe.
 *
 * ## Nunca deixar caixa vazia
 *
 * O iframe nasce **fora do fluxo e invisível** (altura 0 no layout, opacidade
 * 0, sem clique), com a janela do tamanho real para a tag renderizar. O
 * documento isolado mede o que a Monetag pintou e avisa por `postMessage`:
 * com criativo, o slot entra no fluxo com a label; sem criativo em
 * `TEMPO_SEM_ANUNCIO_MS`, o slot é desmontado. Se o criativo some depois (o
 * usuário fechou), a caixa volta a ocupar zero até outro aparecer.
 *
 * ## Isolamento
 *
 * O script publicitário nunca roda neste documento. Ele vive em
 * `/desktop/banner.html`, num iframe `sandbox` sem `allow-same-origin` (ver
 * `SANDBOX_DO_BANNER`). O preload do Electron só roda no frame principal, e o
 * main.js prende o iframe ao próprio documento e manda cliques externos ao
 * navegador do sistema. A única via de volta é a mensagem `{estado, altura}`,
 * aceita só deste iframe (`source`) e de origem opaca.
 */

/**
 * Decisão reaproveitada entre slots e páginas. Expira na mesma janela do cache
 * de entitlements (120 s): a assinatura é feita no navegador do sistema e não
 * recarrega o app.
 */
const VALIDADE_MS = 120_000;
let decisao: Promise<boolean> | null = null;
let decididoEm = 0;

function perguntarAoServidor(): Promise<boolean> {
  if (!decisao || Date.now() - decididoEm > VALIDADE_MS) {
    decididoEm = Date.now();
    const pedido = fetch("/api/ads/banner-desktop", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`))))
      .then((corpo: { exibir?: unknown }) => corpo?.exibir === true);
    // Falha não fica memorizada (a próxima página tenta de novo) e não mostra banner.
    decisao = pedido.catch(() => { decisao = null; return false; });
  }
  return decisao;
}

/** Compartilhado por todos os slots desta carga do app. */
const falhas = criarControleDeFalhas();

function noAplicativoWindows(): boolean {
  const ponte = (window as { obaflixDesktop?: { isDesktop?: unknown; platform?: unknown } }).obaflixDesktop;
  return ponte?.isDesktop === true && ponte.platform !== "android";
}

/** Tela cheia do documento (player) ou da janela nativa (F11 / fallback do Electron). */
function emTelaCheia(): boolean {
  if (document.fullscreenElement) return true;
  if (window.matchMedia?.("(display-mode: fullscreen)").matches) return true;
  return Math.abs(window.innerWidth - screen.width) <= 1 && Math.abs(window.innerHeight - screen.height) <= 1;
}

function useTelaCheia(): boolean {
  const [cheia, setCheia] = useState(false);
  useEffect(() => {
    const atualizar = () => setCheia(emTelaCheia());
    atualizar();
    const mq = window.matchMedia?.("(display-mode: fullscreen)");
    document.addEventListener("fullscreenchange", atualizar);
    window.addEventListener("resize", atualizar);
    mq?.addEventListener?.("change", atualizar);
    return () => {
      document.removeEventListener("fullscreenchange", atualizar);
      window.removeEventListener("resize", atualizar);
      mq?.removeEventListener?.("change", atualizar);
    };
  }, []);
  return cheia;
}

const MOLDURA: Record<PosicaoDoBanner, { sempre: string; visivel: string; largura: number | "100%" }> = {
  // Mesmo recuo lateral das fileiras (LandscapeRow: px-4 md:px-14).
  feed: { sempre: "", visivel: "px-4 md:px-14 py-3", largura: "100%" },
  detalhe: { sempre: "", visivel: "px-4 md:px-14 pt-4 pb-2", largura: "100%" },
  // Largura fixa: a coluna do meio do player se ajusta ao conteúdo (sinopse),
  // e `100%` cortaria o criativo. Janela baixa: o bloco já disputa espaço com
  // os controles; `display:none` também impede a montagem.
  player: { sempre: "[@media(max-height:599px)]:hidden", visivel: "pt-3", largura: 360 },
};

type Props = {
  posicao?: PosicaoDoBanner;
  /** `false` enquanto o contêiner está invisível (overlay do player escondido): sem clique acidental. */
  interativo?: boolean;
  className?: string;
};

export function BannerDesktop({ posicao = "feed", interativo = true, className = "" }: Props) {
  const [elegivel, setElegivel] = useState(false);
  const telaCheia = useTelaCheia();

  useEffect(() => {
    if (!noAplicativoWindows()) return;
    let vivo = true;
    perguntarAoServidor().then((ok) => { if (vivo) setElegivel(ok); });
    return () => { vivo = false; };
  }, []);

  if (!elegivel || telaCheia) return null;
  return <SlotDoBanner posicao={posicao} interativo={interativo} className={className} />;
}

function SlotDoBanner({ posicao, interativo, className }: Required<Props>) {
  const raizRef = useRef<HTMLElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [montado, setMontado] = useState(false);
  const [descartado, setDescartado] = useState(false);
  const [exibindo, setExibindo] = useState(false);
  const [altura, setAltura] = useState(ALTURA_DO_BANNER[posicao].inicial);
  const jaEntregou = useRef(false);

  // Só monta perto da área visível: slot lá embaixo não roda a tag à toa.
  useEffect(() => {
    const raiz = raizRef.current;
    if (!raiz || montado) return;
    const io = new IntersectionObserver((entradas) => {
      if (!entradas.some((e) => e.isIntersecting)) return;
      io.disconnect();
      if (falhas.podeTentar(Date.now())) setMontado(true);
      else setDescartado(true);
    }, { rootMargin: "400px 0px" });
    io.observe(raiz);
    return () => io.disconnect();
  }, [montado]);

  // Mensagens do documento isolado — só deste iframe, só de origem opaca.
  useEffect(() => {
    if (!montado) return;
    const aoReceber = (e: MessageEvent) => {
      const alvo = iframeRef.current?.contentWindow;
      if (!alvo || e.source !== alvo || e.origin !== "null") return;
      const msg = lerMensagemDoBanner(e.data);
      if (!msg) return;
      if (msg.estado === "anuncio") {
        if (!jaEntregou.current) { jaEntregou.current = true; falhas.registrarSucesso(); }
        setAltura(alturaDoIframe(posicao, msg.altura));
        setExibindo(true);
      } else {
        setExibindo(false);
      }
    };
    window.addEventListener("message", aoReceber);
    return () => window.removeEventListener("message", aoReceber);
  }, [montado, posicao]);

  // Sem criativo no prazo (contado da montagem do iframe): some tudo, inclusive
  // a tag. Slot desmontado antes do prazo (navegação) não conta como falha.
  useEffect(() => {
    if (!montado) return;
    const t = window.setTimeout(() => {
      if (jaEntregou.current) return;
      falhas.registrarFalha(Date.now());
      setDescartado(true);
    }, TEMPO_SEM_ANUNCIO_MS);
    return () => window.clearTimeout(t);
  }, [montado]);

  if (descartado) return null;

  const moldura = MOLDURA[posicao];
  const clicavel = exibindo && interativo;
  // O que decide espaço e clique vai inline, não em classe: se a CSS atrasar ou
  // falhar, um iframe em detecção não pode ocupar altura nem capturar clique.
  return (
    <aside
      ref={raizRef}
      aria-label={exibindo ? "Publicidade" : undefined}
      aria-hidden={exibindo ? undefined : true}
      data-banner-posicao={posicao}
      data-banner-estado={exibindo ? "exibindo" : montado ? "detectando" : "aguardando"}
      className={`${moldura.sempre} ${exibindo ? `${moldura.visivel} ${className}` : ""}`}
      style={exibindo ? undefined : { position: "relative", height: 0, overflow: "visible", padding: 0, margin: 0 }}
    >
      {exibindo && (
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Publicidade</p>
      )}
      {montado && (
        <iframe
          ref={iframeRef}
          title="Publicidade"
          src={urlDoBanner(posicao)}
          sandbox={SANDBOX_DO_BANNER}
          referrerPolicy="no-referrer"
          scrolling="no"
          tabIndex={clicavel ? 0 : -1}
          className={exibindo ? "block rounded-lg" : undefined}
          style={
            exibindo
              ? { height: altura, width: moldura.largura, maxWidth: "100%", border: 0, pointerEvents: clicavel ? "auto" : "none" }
              // Acima do slot (top negativo): em detecção não estende a rolagem da
              // página, nem quando é o último slot. Continua na janela para a tag.
              : { height: altura, border: 0, pointerEvents: "none", position: "absolute", left: 0, top: -altura, width: moldura.largura, maxWidth: "100%", opacity: 0 }
          }
        />
      )}
    </aside>
  );
}
