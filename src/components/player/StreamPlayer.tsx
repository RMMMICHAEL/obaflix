"use client";

import { useEffect, useRef, useState } from "react";

// hls.js is loaded dynamically to avoid SSR issues
type HlsInstance = {
  loadSource: (src: string) => void;
  attachMedia: (el: HTMLVideoElement) => void;
  destroy: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  Events: { ERROR: string; MANIFEST_PARSED: string };
};

interface Props {
  stream: string;
  tipo: "hls" | "mp4";
  onError?: () => void;
  onTimeUpdate?: (sec: number) => void;
  startAt?: number;
}

export function StreamPlayer({ stream, tipo, onError, onTimeUpdate, startAt }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setReady(false);

    async function init() {
      if (!video) return;

      if (tipo === "mp4") {
        video.src = stream;
        setReady(true);
        return;
      }

      // HLS
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari native HLS
        video.src = stream;
        setReady(true);
        return;
      }

      const HlsModule = await import("hls.js");
      const Hls = HlsModule.default;

      if (!Hls.isSupported()) {
        onError?.();
        return;
      }

      hlsRef.current?.destroy();
      const hls = new Hls() as unknown as HlsInstance;
      hlsRef.current = hls;

      hls.on(hls.Events.ERROR, () => onError?.());
      hls.on(hls.Events.MANIFEST_PARSED, () => {
        setReady(true);
        video.play().catch(() => {});
      });

      hls.loadSource(stream);
      hls.attachMedia(video);
    }

    init();

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [stream, tipo, onError]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready || !startAt) return;
    video.currentTime = startAt;
  }, [ready, startAt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const handler = () => onTimeUpdate?.(Math.floor(video.currentTime));
    video.addEventListener("timeupdate", handler);
    return () => video.removeEventListener("timeupdate", handler);
  }, [onTimeUpdate]);

  return (
    <video
      ref={videoRef}
      className="w-full h-full bg-black"
      controls
      autoPlay
      playsInline
    />
  );
}
