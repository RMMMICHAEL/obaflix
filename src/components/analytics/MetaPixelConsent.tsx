"use client";

import Script from "next/script";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  CONSENTIMENTO_ANUNCIOS, EVENTO_PIXEL_PRONTO, EVENTO_PREFERENCIAS, META_PIXEL_ID, enviarEventoMeta, pixelPronto,
} from "@/lib/metaPixelCortes";

// Cópia da escolha em cookie de primeira parte: o servidor só registra o consentimento no pedido se ele existir.
const gravarCookie = (sim: boolean) => {
  document.cookie = `obaflix_ads=${sim ? "1" : ""}; path=/; max-age=${sim ? 15552000 : 0}; SameSite=Lax; Secure`;
};

const lerEscolha = () => {
  try { return localStorage.getItem(CONSENTIMENTO_ANUNCIOS); } catch { return null; }
};

/** Botão do rodapé para o visitante rever a escolha. */
export function BotaoPreferenciasCookies({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <button type="button" className={className} style={style} onClick={() => window.dispatchEvent(new Event(EVENTO_PREFERENCIAS))}>
      Preferências de cookies
    </button>
  );
}

/** Pixel só carrega após aceite explícito. O layout já exclui a superfície admin. */
export function MetaPixelConsent() {
  const pathname = usePathname();
  const [escolha, setEscolha] = useState<string | null | undefined>(undefined);
  const [pronto, setPronto] = useState(false);
  const [aberto, setAberto] = useState(false);
  const ultimaRota = useRef<string | null>(null);

  useEffect(() => {
    const e = lerEscolha();
    if (e) gravarCookie(e === "sim");
    setEscolha(e);
    setAberto(e === null);
    const reabrir = () => setAberto(true);
    window.addEventListener(EVENTO_PREFERENCIAS, reabrir);
    return () => window.removeEventListener(EVENTO_PREFERENCIAS, reabrir);
  }, []);

  // Pixel pronto = fbq existe (o snippet oficial enfileira até a biblioteca baixar). Avisa quem aguardava.
  useEffect(() => {
    if (escolha !== "sim") return;
    let n = 0;
    const t = window.setInterval(() => {
      if (pixelPronto() || ++n > 50) {
        window.clearInterval(t);
        if (pixelPronto()) { setPronto(true); window.dispatchEvent(new Event(EVENTO_PIXEL_PRONTO)); }
      }
    }, 100);
    return () => window.clearInterval(t);
  }, [escolha]);

  // Um PageView por rota, só com consentimento e Pixel pronto.
  useEffect(() => {
    if (escolha !== "sim" || !pronto || pathname.startsWith("/admin") || ultimaRota.current === pathname) return;
    if (enviarEventoMeta("PageView")) ultimaRota.current = pathname;
  }, [escolha, pronto, pathname]);

  if (pathname.startsWith("/admin")) return null;
  const decidir = (v: "sim" | "nao") => {
    try { localStorage.setItem(CONSENTIMENTO_ANUNCIOS, v); } catch {}
    gravarCookie(v === "sim");
    // Revogar depois de aceitar: recarrega para descartar o Pixel já carregado.
    if (v === "nao" && escolha === "sim") { window.location.reload(); return; }
    setEscolha(v);
    setAberto(false);
  };

  return (
    <>
      {escolha === "sim" && (
        <Script id="meta-pixel" strategy="afterInteractive">{`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');`}</Script>
      )}
      {aberto && (
        <div role="dialog" aria-label="Preferências de cookies" style={{ position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 60, maxWidth: 560, margin: "0 auto", background: "#18181b", color: "#e4e4e7", border: "1px solid #3f3f46", borderRadius: 12, padding: 16, fontSize: 13 }}>
          <p>Usamos o Pixel da Meta para medir anúncios. Você aceita? Veja a <Link href="/privacidade" style={{ textDecoration: "underline" }}>Política de Privacidade</Link>. Você pode mudar depois em “Preferências de cookies”.</p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={() => decidir("sim")} style={{ background: "#dc2626", color: "#fff", borderRadius: 8, padding: "8px 14px" }}>Aceitar</button>
            <button type="button" onClick={() => decidir("nao")} style={{ border: "1px solid #52525b", borderRadius: 8, padding: "8px 14px" }}>Recusar</button>
          </div>
        </div>
      )}
    </>
  );
}
