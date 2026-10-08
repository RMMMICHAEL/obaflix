"use client";

import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Copy, Check } from "lucide-react";
import { detectInAppBrowser, type InAppBrowser } from "@/lib/in-app-browser";
import { PUBLIC_LANDING_URL, androidViewIntentUrl } from "@/config/public-download";
import styles from "@/app/baixar/baixar.module.css";

/**
 * CTA de download que decide o rótulo no cliente — e só ele.
 *
 * Em navegador normal (Chrome, Samsung Internet, Firefox, Edge…) o botão é
 * exatamente o de sempre: "Baixar para Android" apontando para
 * `/download/android`. Nada do fluxo de download homologado muda.
 *
 * Dentro de um navegador interno de aplicativo no Android, onde o toque no APK
 * não inicia o download, o CTA vira "Abrir no navegador": tenta mandar a página
 * canônica para o navegador externo do Android via Intent URI. Como esse atalho
 * pode ser bloqueado pelo próprio aplicativo, ao tocar também revelamos uma
 * instrução curta (menu ⋯ → "Abrir no navegador") e um "Copiar link".
 *
 * O que ele NÃO faz, de propósito: não dispara download automático, não navega
 * para o APK sozinho, não usa iframe, click simulado nem timer. A única ação é a
 * do usuário. O destino externo é sempre a constante `PUBLIC_LANDING_URL` — nunca
 * o Host da request, preview ou query.
 */

/** Evento interno para a barra inferior revelar a ajuda que vive na hero. */
const EVENTO_ABRIR = "obaflix:abrir-navegador";

/** Intent URI fixo, derivado uma única vez da URL canônica. */
const INTENT_URL = androidViewIntentUrl(PUBLIC_LANDING_URL);

/**
 * - `hero`   — CTA principal. É o único dono da caixa de ajuda/fallback e o único
 *   que escuta o evento; qualquer botão da página a revela por aqui.
 * - `primary` — CTA full-size secundário (seção final). Mesmo botão, sem caixa
 *   própria: ao tocar, revela a caixa da hero.
 * - `bar`    — botão compacto da barra inferior.
 */
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

function tentarAbrirNavegador() {
  // Avisa a hero para revelar a ajuda, aconteça o que acontecer com o Intent.
  window.dispatchEvent(new Event(EVENTO_ABRIR));
  if (!INTENT_URL) return;
  try {
    window.location.href = INTENT_URL;
  } catch {
    // Alguns WebViews recusam o esquema intent://. A ajuda já foi revelada acima.
  }
}

export function AndroidDownloadCta({ downloadPath, variant = "primary" }: { downloadPath: string; variant?: Variant }) {
  // Primeira renderização igual ao HTML estático (browser), para não haver
  // divergência de hidratação; a detecção real roda logo depois, no cliente.
  const [ambiente, setAmbiente] = useState<InAppBrowser>("browser");
  const [mostrarAjuda, setMostrarAjuda] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const ajudaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAmbiente(resolverAmbiente());
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

  if (ambiente === "browser") {
    return (
      <a href={downloadPath} className={styles.primary} aria-label="Baixar APK do Obaflix para Android">
        <Download size={compact ? 17 : 21} aria-hidden="true" />
        {compact ? "Baixar" : "Baixar para Android"}
      </a>
    );
  }

  const copiarLink = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(PUBLIC_LANDING_URL);
      ok = true;
    } catch {
      // Fallback para WebViews sem Clipboard API: seleção + execCommand.
      const campo = document.createElement("textarea");
      campo.value = PUBLIC_LANDING_URL;
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
    <button type="button" onClick={tentarAbrirNavegador} className={styles.primary} aria-label="Abrir esta página no navegador do celular">
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
