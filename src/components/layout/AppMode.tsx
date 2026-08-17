"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

// ── Fonte única de verdade do "modo app" ──────────────────────────────────────
// Antes, três lugares decidiam isso por conta própria e em momentos diferentes:
//   1. Navbar   → só olhava se a rota era /android (síncrono);
//   2. AndroidShell → olhava sessionStorage/UA dentro de um useEffect (pós-hidratação);
//   3. globals.css  → escondia a navbar com `display:none` a partir de uma classe
//      que também só era aplicada num useEffect.
// Resultado: em /filmes, /series, /desenhos etc. dentro do app, a Navbar desktop e a
// topbar mobile existiam ao mesmo tempo — duas logos, duas lupas, headers sobrepostos.
// Agora as duas árvores consultam este contexto, então nunca podem discordar.

export type AppMode = "web" | "android";

const AppModeContext = createContext<AppMode>("web");

export const useAppMode = () => useContext(AppModeContext);

/** Rotas do player: mesmo em modo app, elas não recebem topbar nem bottom nav. */
const PLAYER_ROUTES = ["/assistir/", "/player"];

export const APP_MODE_STORAGE_KEY = "obaflixAndroidMode";

/**
 * Regra de detecção. Vive aqui e é replicada literalmente no script inline do
 * layout — se mudar uma, mude a outra.
 */
export function detectAndroidMode(pathname: string): boolean {
  if (pathname === "/android" || pathname.startsWith("/android/")) return true;
  if (typeof window === "undefined") return false;
  const desktop = (window as { obaflixDesktop?: { platform?: string } }).obaflixDesktop;
  return (
    desktop?.platform === "android" ||
    (window as { __OBAFLIX_ANDROID__?: boolean }).__OBAFLIX_ANDROID__ === true ||
    /ObaflixApp\//i.test(navigator.userAgent) ||
    window.sessionStorage.getItem(APP_MODE_STORAGE_KEY) === "1"
  );
}

export function isPlayerRoute(pathname: string) {
  return PLAYER_ROUTES.some((route) => pathname.startsWith(route));
}

export function AppModeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // O estado inicial já é o correto na primeira renderização do cliente — não há
  // um passo intermediário em que Navbar e AndroidShell enxergam coisas diferentes.
  // No servidor só a rota é conhecida, e é isso que o script inline compensa.
  const [mode, setMode] = useState<AppMode>(() =>
    detectAndroidMode(pathname) ? "android" : "web",
  );

  useEffect(() => {
    const routePreview = pathname === "/android" || pathname.startsWith("/android/");
    // Entrar por /android trava o modo app para o resto da sessão, inclusive nas
    // rotas compartilhadas com o site desktop.
    if (routePreview) window.sessionStorage.setItem(APP_MODE_STORAGE_KEY, "1");
    setMode(detectAndroidMode(pathname) ? "android" : "web");
  }, [pathname]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("obaflix-android-app", mode === "android");
    root.classList.toggle("obaflix-player-mode", mode === "android" && isPlayerRoute(pathname));
  }, [mode, pathname]);

  const value = useMemo(() => mode, [mode]);
  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
}

/**
 * Script bloqueante injetado no <head>. Roda antes da primeira pintura e aplica a
 * classe no <html>, de modo que o CSS já esconda a navbar desktop no HTML do SSR.
 * Sem ele haveria um flash com os dois cabeçalhos antes da hidratação.
 */
export const APP_MODE_BOOTSTRAP_SCRIPT = `
(function(){try{
  var p = location.pathname;
  var app = p === "/android" || p.indexOf("/android/") === 0;
  if (app) { try { sessionStorage.setItem("${APP_MODE_STORAGE_KEY}", "1"); } catch (e) {} }
  if (!app) {
    app = (window.obaflixDesktop && window.obaflixDesktop.platform === "android") ||
      window.__OBAFLIX_ANDROID__ === true ||
      /ObaflixApp\\//i.test(navigator.userAgent);
    if (!app) { try { app = sessionStorage.getItem("${APP_MODE_STORAGE_KEY}") === "1"; } catch (e) {} }
  }
  if (app) {
    var d = document.documentElement;
    d.classList.add("obaflix-android-app");
    if (p.indexOf("/assistir/") === 0 || p.indexOf("/player") === 0) d.classList.add("obaflix-player-mode");
  }
}catch(e){}})();
`;
