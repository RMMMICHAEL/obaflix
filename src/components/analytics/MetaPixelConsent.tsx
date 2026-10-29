"use client";

import Script from "next/script";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CONSENTIMENTO_ANUNCIOS, META_PIXEL_ID, enviarEventoMeta } from "@/lib/metaPixelCortes";

const lerEscolha = () => {
  try { return localStorage.getItem(CONSENTIMENTO_ANUNCIOS); } catch { return null; }
};

/** Pixel só carrega após aceite explícito. Não renderiza em /admin (o layout já exclui a superfície admin). */
export function MetaPixelConsent() {
  const pathname = usePathname();
  const [escolha, setEscolha] = useState<string | null | undefined>(undefined);

  useEffect(() => setEscolha(lerEscolha()), []);
  // Um PageView por rota; o init acontece uma única vez no script.
  useEffect(() => {
    if (escolha === "sim" && !pathname.startsWith("/admin")) enviarEventoMeta("PageView");
  }, [escolha, pathname]);

  if (pathname.startsWith("/admin")) return null;
  const decidir = (v: "sim" | "nao") => {
    try { localStorage.setItem(CONSENTIMENTO_ANUNCIOS, v); } catch {}
    setEscolha(v);
  };

  return (
    <>
      {escolha === "sim" && (
        <Script id="meta-pixel" strategy="afterInteractive">{`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');`}</Script>
      )}
      {escolha === null && (
        <div role="dialog" aria-label="Preferências de publicidade" style={{ position: "fixed", left: 12, right: 12, bottom: 12, zIndex: 60, maxWidth: 560, margin: "0 auto", background: "#18181b", color: "#e4e4e7", border: "1px solid #3f3f46", borderRadius: 12, padding: 16, fontSize: 13 }}>
          <p>Usamos o Pixel da Meta para medir anúncios. Você aceita? Veja a <Link href="/privacidade" style={{ textDecoration: "underline" }}>Política de Privacidade</Link>.</p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={() => decidir("sim")} style={{ background: "#dc2626", color: "#fff", borderRadius: 8, padding: "8px 14px" }}>Aceitar</button>
            <button type="button" onClick={() => decidir("nao")} style={{ border: "1px solid #52525b", borderRadius: 8, padding: "8px 14px" }}>Recusar</button>
          </div>
        </div>
      )}
    </>
  );
}
