"use client";

import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Copy, Check } from "lucide-react";
import { detectInAppBrowser, type InAppBrowser } from "@/lib/in-app-browser";
import { parseUtm, buildLandingExternalUrl, buildLandingIntentUrl, type Utm } from "@/lib/marketing/utm";
import { sendLandingEvent } from "@/lib/marketing/landing-analytics";
import type { LandingContext, LandingPlacement } from "@/lib/marketing/landing-event";
import styles from "@/app/baixar/baixar.module.css";

/**
 * CTA de download que decide o rótulo no cliente — e só ele.
 *
 * Em navegador normal (Chrome, Samsung Internet, Firefox, Edge…) o botão é o de
 * sempre: "Baixar para Android" apontando para `/download/android`. Nada do
 * fluxo de download homologado muda, e NENHUM UTM é anexado a `/download/android`.
 *
 * Dentro de um navegador interno de aplicativo no Android, o CTA vira "Abrir no
 * navegador": tenta mandar a URL canônica para o navegador externo via Intent
 * URI, preservando apenas os UTMs válidos. Como o atalho pode ser bloqueado,
 * ao tocar revelamos instrução curta (menu ⋯) e "Copiar link".
 *
 * Métrica first-party (fail-open): dispara landing_view (só a hero, uma vez),
 * open_external_browser_click (ao abrir navegador) e android_download_click (ao
 * baixar). Sempre antes de navegar e nunca bloqueando a navegação. Sem cookie,
 * sem identificador. O destino externo é sempre `obaflixbr.com/baixar`.
 */

/** Evento interno para a barra inferior revelar a ajuda que vive na hero. */
const EVENTO_ABRIR = "obaflix:abrir-navegador";

type Variant = "hero" | "primary" | "bar";

/**
 * Só em desenvolvimento: `?obaflix-simular=in-app` força o estado de navegador
 * interno para homologar o visual sem depender do aplicativo real. Em produção
 * `process.env.NODE_ENV` é `"production"`, o bloco vira código morto e some do
 * bundle — não existe query de produção que troque o comportamento.
 */
function resolverAmbiente(): InAppBrowser {
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
    const simular = new URLSearchParams(window.location.search).get("obaflix-simular");
    if (simular === "in-app" || simular === "tiktok") return "tiktok";
    if (simular === "browser") return "browser";
  }
  return detectInAppBrowser(typeof navigator !== "undefined" ? navigator.userAgent : "");
}

const contextoDe = (ambiente: InAppBrowser): LandingContext => (ambiente === "browser" ? "browser" : "in_app");
const placementDe = (variant: Variant): LandingPlacement => (variant === "hero" ? "hero" : variant === "bar" ? "bar" : "final");
const utmAtual = (): Utm => parseUtm(typeof window !== "undefined" ? window.location.search : "");

export function AndroidDownloadCta({ downloadPath, variant = "primary" }: { downloadPath: string; variant?: Variant }) {
  // Primeira renderização igual ao HTML estático (browser), para não haver
  // divergência de hidratação; a detecção real roda logo depois, no cliente.
  const [ambiente, setAmbiente] = useState<InAppBrowser>("browser");
  const [mostrarAjuda, setMostrarAjuda] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const ajudaRef = useRef<HTMLDivElement>(null);
  const viewEnviado = useRef(false);

  useEffect(() => {
    const amb = resolverAmbiente();
    setAmbiente(amb);
    // landing_view uma única vez por montagem — só o CTA hero dispara (há três
    // CTAs na página). O ref evita o duplo disparo do StrictMode em dev.
    if (variant === "hero" && !viewEnviado.current) {
      viewEnviado.current = true;
      sendLandingEvent({ event: "landing_view", context: contextoDe(amb), placement: "page", attribution: utmAtual() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (variant !== "hero") return;
    const aoAbrir = () => {
      setMostrarAjuda(true);
      requestAnimationFrame(() => ajudaRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
    };
    window.addEventListener(EVENTO_ABRIR, aoAbrir);
    return () => window.removeEventListener(EVENTO_ABRIR, aoAbrir);
  }, [variant]);

  const compact = variant === "bar";
  const placement = placementDe(variant);

  if (ambiente === "browser") {
    const aoBaixar = () => {
      // Clique (não instalação). Segue imediatamente para /download/android.
      sendLandingEvent({ event: "android_download_click", context: "browser", placement, attribution: utmAtual() });
    };
    return (
      <a href={downloadPath} onClick={aoBaixar} className={styles.primary} aria-label="Baixar APK do Obaflix para Android">
        <Download size={compact ? 17 : 21} aria-hidden="true" />
        {compact ? "Baixar" : "Baixar para Android"}
      </a>
    );
  }

  const abrirNoNavegador = () => {
    const utm = utmAtual();
    // open_external_browser_click ANTES do Intent (fire-and-forget).
    sendLandingEvent({ event: "open_external_browser_click", context: "in_app", placement, attribution: utm });
    window.dispatchEvent(new Event(EVENTO_ABRIR));
    const intent = buildLandingIntentUrl(utm);
    try {
      window.location.href = intent;
    } catch {
      // Alguns WebViews recusam o esquema intent://. A ajuda já foi revelada.
    }
  };

  const copiarLink = async () => {
    const link = buildLandingExternalUrl(utmAtual());
    let ok = false;
    try {
      await navigator.clipboard.writeText(link);
      ok = true;
    } catch {
      // Fallback para WebViews sem Clipboard API: seleção + execCommand.
      const campo = document.createElement("textarea");
      campo.value = link;
      campo.setAttribute("readonly", "");
      campo.style.position = "fixed";
      campo.style.opacity = "0";
      document.body.appendChild(campo);
      campo.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(campo);
    }
    setCopiado(ok);
    if (ok) window.setTimeout(() => setCopiado(false), 2200);
  };

  const botao = (
    <button type="button" onClick={abrirNoNavegador} className={styles.primary} aria-label="Abrir esta página no navegador do celular">
      <ExternalLink size={compact ? 17 : 21} aria-hidden="true" />
      {compact ? "Abrir navegador" : "Abrir no navegador"}
    </button>
  );

  // Na barra inferior fica só o botão: a ajuda e o "Copiar link" vivem na hero,
  // reveladas pelo mesmo evento quando a barra também é tocada.
  if (compact) return botao;

  return (
    <div className={styles.ctaOpen}>
      {botao}
      <p className={styles.caption}>Para baixar o APK, abra esta página no navegador do celular.</p>
      {variant === "hero" && mostrarAjuda && (
        <div className={styles.fallback} role="status" ref={ajudaRef}>
          <strong>Abra no navegador para continuar</strong>
          <p>Use o menu ⋯ deste aplicativo e escolha &ldquo;Abrir no navegador&rdquo;. Depois toque em Baixar para Android.</p>
          <button type="button" onClick={copiarLink} className={styles.copyButton} aria-live="polite">
            {copiado ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copiado ? "Link copiado" : "Copiar link"}
          </button>
        </div>
      )}
    </div>
  );
}
