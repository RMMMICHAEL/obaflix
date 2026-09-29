"use client";

import { useEffect, useState } from "react";
import { DOCUMENTO_DO_BANNER, SANDBOX_DO_BANNER } from "@/lib/ads/bannerDesktop";

/**
 * Espaço publicitário do aplicativo Windows. Em qualquer outro ambiente não
 * renderiza nada e não faz requisição nenhuma.
 *
 * ## Duas portas, nesta ordem
 *
 *  1. **cliente** — `obaflixDesktop.isDesktop === true`. Só o preload do
 *     Electron (`contextBridge`) define isso; o shim do Android define
 *     `platform: "android"` e nunca `isDesktop`. Navegador comum e Android
 *     param aqui, sem fetch;
 *  2. **servidor** — `/api/ads/banner-desktop` decide pelo direito da conta
 *     (assinante pago não vê) e pela flag de servidor.
 *
 * Mesmo que as duas falhassem num navegador, a CSP da web (`frame-src 'none'`
 * fora de `/assistir`) recusaria o iframe; é o Electron que remove a CSP das
 * respostas do Obaflix.
 *
 * ## Isolamento
 *
 * O script publicitário nunca roda neste documento. Ele vive em
 * `DOCUMENTO_DO_BANNER`, num iframe `sandbox` sem `allow-same-origin` — ver
 * `SANDBOX_DO_BANNER` em `src/lib/ads/bannerDesktop.ts`. Além disso, o preload
 * do Electron só roda no frame principal: o iframe nem tem `ipcRenderer`.
 *
 * Não usar em player, login, planos/checkout nem em rota que Android/TV exibam
 * como tela própria — a regra está no pedido de monetização do desktop.
 */

/**
 * Decisão reaproveitada entre páginas. Expira na mesma janela do cache de
 * entitlements (120 s): a assinatura é feita no navegador do sistema e não
 * recarrega o app, então quem acabou de pagar deixa de ver o banner na próxima
 * página depois dessa janela, sem precisar reiniciar.
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

function noAplicativoWindows(): boolean {
  const ponte = (window as { obaflixDesktop?: { isDesktop?: unknown; platform?: unknown } }).obaflixDesktop;
  return ponte?.isDesktop === true && ponte.platform !== "android";
}

export function BannerDesktop({ className = "" }: { className?: string }) {
  const [exibir, setExibir] = useState(false);

  useEffect(() => {
    if (!noAplicativoWindows()) return;
    let vivo = true;
    perguntarAoServidor().then((ok) => { if (vivo) setExibir(ok); });
    return () => { vivo = false; };
  }, []);

  if (!exibir) return null;

  return (
    <aside aria-label="Publicidade" className={`px-4 md:px-8 my-6 ${className}`}>
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-600">Publicidade</p>
      <iframe
        title="Publicidade"
        src={DOCUMENTO_DO_BANNER}
        sandbox={SANDBOX_DO_BANNER}
        referrerPolicy="no-referrer"
        loading="lazy"
        scrolling="no"
        className="block h-[120px] w-full max-w-[728px] rounded-lg border border-white/5 bg-white/[0.02]"
      />
    </aside>
  );
}
