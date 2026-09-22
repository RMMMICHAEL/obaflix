"use client";

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";

/**
 * Link para as rotas de assinatura (`/planos`, `/checkout`).
 *
 * No navegador comum e no Android é um `next/link` idêntico ao de sempre. No
 * Electron, porém, o fluxo de assinatura/pagamento (login externo, PIX/Blackcat)
 * foi desenhado para o navegador do sistema e não pode ficar preso na janela do
 * app. O `desktop/electron/main.js` já desvia navegação full-page (`will-navigate`)
 * e `window.open` (`setWindowOpenHandler`) para fora — mas o clique num `next/link`
 * navega por History API (client-side), que não dispara aqueles eventos, então
 * esses destinos escapavam para dentro da BrowserWindow.
 *
 * Aqui, e só aqui, quando `obaflixDesktop.isDesktop` é verdade e o destino é
 * `/planos` ou `/checkout`, interceptamos ANTES do router: `preventDefault` e
 * entregamos a URL absoluta (mesma origem) à ponte `openExternal`, que o processo
 * principal valida (origem + rota + https) antes de `shell.openExternal`. Fora do
 * Electron, ou para qualquer outro destino, segue como navegação interna normal.
 * É um componente central de propósito: não mexemos no History API global.
 */

type PonteDesktopExterno = {
  isDesktop?: boolean;
  openExternal?: (url: string) => unknown;
};

const ROTA_EXTERNA = /^\/(?:planos|checkout)(?:[/?#]|$)/;

export function LinkAssinatura({ href, onClick, ...props }: ComponentProps<typeof Link>) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;

    // Só desviamos destinos de assinatura conhecidos; o resto é Link comum.
    if (typeof href !== "string" || !ROTA_EXTERNA.test(href)) return;

    // Cliques com modificador ou botão não-primário (nova aba, salvar, meio)
    // seguem o comportamento padrão do navegador — não sequestramos.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const ponte = (window as unknown as { obaflixDesktop?: PonteDesktopExterno }).obaflixDesktop;
    if (!ponte?.isDesktop || typeof ponte.openExternal !== "function") return;

    event.preventDefault();
    ponte.openExternal(new URL(href, window.location.origin).toString());
  };

  return <Link href={href} onClick={handleClick} {...props} />;
}
