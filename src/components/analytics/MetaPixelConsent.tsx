"use client";

import Script from "next/script";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  CONSENTIMENTO_ANUNCIOS, EVENTO_PIXEL_PRONTO, EVENTO_PREFERENCIAS, META_PIXEL_ID, enviarEventoMeta, pixelPronto,
} from "@/lib/metaPixelCortes";

const jaViu = () => {
  try { return localStorage.getItem(CONSENTIMENTO_ANUNCIOS) !== null; } catch { return false; }
};

/** Botão do rodapé para reler o aviso. */
export function BotaoPreferenciasCookies({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <button type="button" className={className} style={style} onClick={() => window.dispatchEvent(new Event(EVENTO_PREFERENCIAS))}>
      Aviso de cookies
    </button>
  );
}

/**
 * Meta Pixel sempre ativo fora do admin (o layout já exclui a superfície admin e a rota é conferida aqui).
 * O aviso é só informativo: não oferece recusa, porque o Pixel não é desligado por ele.
 */
export function MetaPixelConsent() {
  const pathname = usePathname();
  const admin = pathname.startsWith("/admin");
  const [pronto, setPronto] = useState(false);
  const [aberto, setAberto] = useState(false);
  const ultimaRota = useRef<string | null>(null);

  useEffect(() => {
    setAberto(!jaViu());
    const reabrir = () => setAberto(true);
    window.addEventListener(EVENTO_PREFERENCIAS, reabrir);
    return () => window.removeEventListener(EVENTO_PREFERENCIAS, reabrir);
  }, []);

  // Pixel pronto = fbq existe (o snippet oficial enfileira até a biblioteca baixar). Avisa quem aguardava.
  useEffect(() => {
    if (admin) return;
    let n = 0;
    const t = window.setInterval(() => {
      if (pixelPronto() || ++n > 50) {
        window.clearInterval(t);
        if (pixelPronto()) { setPronto(true); window.dispatchEvent(new Event(EVENTO_PIXEL_PRONTO)); }
      }
    }, 100);
    return () => window.clearInterval(t);
  }, [admin]);

  // Um PageView por rota (navegação), só com o Pixel pronto.
  useEffect(() => {
    if (admin || !pronto || ultimaRota.current === pathname) return;
    if (enviarEventoMeta("PageView")) ultimaRota.current = pathname;
  }, [admin, pronto, pathname]);

  if (admin) return null;
  const entendi = () => {
    try { localStorage.setItem(CONSENTIMENTO_ANUNCIOS, "visto"); } catch {}
    setAberto(false);
  };

  return (
    <>
      <Script id="meta-pixel" strategy="afterInteractive">{`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');`}</Script>
      {aberto && (
        <div role="dialog" aria-label="Aviso de cookies" style={{ position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 60, maxWidth: 560, margin: "0 auto", background: "#18181b", color: "#e4e4e7", border: "1px solid #3f3f46", borderRadius: 12, padding: 16, fontSize: 13 }}>
          <p>Este site usa o Pixel da Meta para medir anúncios. Veja a <Link href="/privacidade" style={{ textDecoration: "underline" }}>Política de Privacidade</Link>.</p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={entendi} style={{ background: "#dc2626", color: "#fff", borderRadius: 8, padding: "8px 14px" }}>Entendi</button>
          </div>
        </div>
      )}
    </>
  );
}
