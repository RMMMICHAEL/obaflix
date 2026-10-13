"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { AdPlacement, AdsRemoteConfig } from "@/lib/ads/remoteConfig";

function placement(path: string): AdPlacement | null {
  if (path === "/") return "home";
  if (path === "/filmes" || path === "/series" || path === "/animes") return path.slice(1) as AdPlacement;
  if (/^\/(filme|serie)\//.test(path)) return "detail";
  return null; // Kids and playback are closed until child/privacy homologation.
}
/** Native banner sits in a reserved band outside the WebView content. */
export function AndroidAdsPlacement() {
  const path = usePathname();
  const [privacy, setPrivacy] = useState(false);
  useEffect(() => {
    const selected = placement(path);
    let active = true;
    let started = false;
    setPrivacy(false);
    const abort = new AbortController();
    const start = () => {
      const bridge = window.obaflixAds;
      if (!active || started || !bridge?.capability || !bridge.mostrarBanner) return;
      started = true;
      const capability = bridge.capability;
      bridge.ocultarBanner?.(capability);
      bridge.configurar?.(capability, "{}");
      if (!selected && path !== "/conta") return;
      fetch("/api/ads/config", { cache: "no-store", signal: abort.signal })
      .then(r => r.ok ? r.json() : null)
      .then((config: AdsRemoteConfig | null) => {
        if (!active || !config) return;
        bridge.configurar?.(capability, JSON.stringify(config));
        if (config.sessionCap <= 0) return;
        setPrivacy(config.banner || config.rewarded || config.interstitial);
        if (!selected || !config.banner || !config.placements.includes(selected)) return;
        bridge.mostrarBanner?.(capability);
      }).catch(() => {});
    };
    const hide = () => {
      const bridge = window.obaflixAds;
      if (bridge?.capability && (document.hidden || document.fullscreenElement)) bridge.ocultarBanner?.(bridge.capability);
    };
    window.addEventListener("obaflixadsready", start);
    start();
    document.addEventListener("fullscreenchange", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      active = false; abort.abort();
      const bridge = window.obaflixAds;
      if (bridge?.capability) bridge.ocultarBanner?.(bridge.capability);
      window.removeEventListener("obaflixadsready", start);
      document.removeEventListener("fullscreenchange", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [path]);
  if (!privacy) return null;
  return <button type="button" className="mx-auto my-4 block text-xs text-gray-400 underline" onClick={() => {
    const bridge = window.obaflixAds;
    if (bridge?.capability) bridge.privacidade?.(bridge.capability);
    setPrivacy(false);
  }}>Opções de privacidade dos anúncios</button>;
}
