"use client";

import { useEffect, useRef } from "react";

/**
 * Mantém a tela ligada somente enquanto o CustomPlayer está aberto.
 *
 * Web, PWA e WebView moderno:
 * usa a Screen Wake Lock API.
 *
 * APK Obaflix:
 * usa a ponte nativa _obaflixBridge.setKeepScreenOn.
 */
export function PlayerWakeLock() {
  const wakeLockRef = useRef<any>(null);
  const nativeStateRef = useRef<boolean | null>(null);

  useEffect(() => {
    let disposed = false;
    let playerMounted = false;

    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    let reacquireTimer: ReturnType<typeof setTimeout> | null = null;

    const setNativeKeepScreenOn = (enabled: boolean) => {
      if (nativeStateRef.current === enabled) return;

      try {
        const bridge = (window as any)._obaflixBridge;

        if (typeof bridge?.setKeepScreenOn !== "function") {
          return;
        }

        bridge.setKeepScreenOn(enabled);
        nativeStateRef.current = enabled;
      } catch (error) {
        console.debug(
          "[wake-lock] Ponte nativa indisponível",
          error,
        );
      }
    };

    const releaseBrowserWakeLock = async () => {
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;

      if (!lock) return;

      try {
        await lock.release();
      } catch {
        // O navegador pode liberar o Wake Lock automaticamente
        // quando a página fica oculta.
      }
    };

    const acquireWakeLock = async () => {
      if (
        disposed ||
        !playerMounted ||
        document.visibilityState !== "visible"
      ) {
        return;
      }

      // No APK, essa é a proteção principal.
      setNativeKeepScreenOn(true);

      // No site, usa a API disponível no navegador.
      if (!("wakeLock" in navigator) || wakeLockRef.current) {
        return;
      }

      try {
        const lock = await (navigator as any).wakeLock.request(
          "screen",
        );

        if (
          disposed ||
          !playerMounted ||
          document.visibilityState !== "visible"
        ) {
          await lock.release().catch(() => {});
          return;
        }

        wakeLockRef.current = lock;

        lock.addEventListener("release", () => {
          if (wakeLockRef.current === lock) {
            wakeLockRef.current = null;
          }

          if (
            disposed ||
            !playerMounted ||
            document.visibilityState !== "visible"
          ) {
            return;
          }

          // Alguns aparelhos liberam o Wake Lock temporariamente.
          // Tenta recuperar sem criar um loop agressivo.
          if (reacquireTimer) {
            clearTimeout(reacquireTimer);
          }

          reacquireTimer = setTimeout(() => {
            void acquireWakeLock();
          }, 750);
        });
      } catch (error) {
        // Pode ser negado por economia de bateria ou política
        // do navegador. No APK, a ponte nativa continua ativa.
        console.debug(
          "[wake-lock] Screen Wake Lock não concedido",
          error,
        );
      }
    };

    const applyPlayerState = () => {
      if (disposed) return;

      // Esse elemento existe somente enquanto o CustomPlayer
      // está montado na página.
      playerMounted =
        document.getElementById("jw-player-container") !== null;

      const shouldStayAwake =
        playerMounted &&
        document.visibilityState === "visible";

      if (shouldStayAwake) {
        void acquireWakeLock();
      } else {
        setNativeKeepScreenOn(false);
        void releaseBrowserWakeLock();
      }
    };

    const scheduleSync = () => {
      if (syncTimer) {
        clearTimeout(syncTimer);
      }

      // Evita desligar e ligar a flag no pequeno intervalo
      // entre a saída de um episódio e a entrada do próximo.
      syncTimer = setTimeout(applyPlayerState, 200);
    };

    const observer = new MutationObserver(scheduleSync);

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    document.addEventListener(
      "visibilitychange",
      scheduleSync,
    );

    window.addEventListener("pagehide", scheduleSync);

    applyPlayerState();

    return () => {
      disposed = true;

      observer.disconnect();

      document.removeEventListener(
        "visibilitychange",
        scheduleSync,
      );

      window.removeEventListener(
        "pagehide",
        scheduleSync,
      );

      if (syncTimer) {
        clearTimeout(syncTimer);
      }

      if (reacquireTimer) {
        clearTimeout(reacquireTimer);
      }

      setNativeKeepScreenOn(false);
      void releaseBrowserWakeLock();
    };
  }, []);

  return null;
}
