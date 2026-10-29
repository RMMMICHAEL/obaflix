"use client";

import { Pause, Play } from "lucide-react";
import { useRef, useState } from "react";

const VIDEO = "https://app.obaflix.online/video-principal.mp4";

/** Sem barra de busca: só play/pause. Sem autoplay; o som só começa por clique do usuário. */
export function VideoVslCortes() {
  const ref = useRef<HTMLVideoElement>(null);
  const [tocando, setTocando] = useState(false);
  const alternar = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => setTocando(false)); else v.pause();
  };
  return (
    <section aria-label="Vídeo de apresentação do Obaflix Cortes" style={{ width: "min(100% - 32px, 1040px)", margin: "24px auto" }}>
      <div style={{ position: "relative", aspectRatio: "16 / 9", borderRadius: 18, overflow: "hidden", background: "transparent", boxShadow: "0 30px 90px -20px rgba(220,38,38,.35), 0 0 0 1px rgba(255,255,255,.08)" }}>
        <video ref={ref} src={VIDEO} preload="metadata" playsInline controlsList="nodownload noplaybackrate" disablePictureInPicture
          onPlay={() => setTocando(true)} onPause={() => setTocando(false)} onEnded={() => setTocando(false)} onClick={alternar}
          style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "transparent" }} />
        <button type="button" onClick={alternar} aria-label={tocando ? "Pausar vídeo" : "Reproduzir vídeo"}
          style={{ position: "absolute", inset: tocando ? "auto 16px 16px auto" : 0, margin: tocando ? 0 : "auto", width: tocando ? 44 : 84, height: tocando ? 44 : 84, borderRadius: 999, background: "#dc2626", color: "#fff", display: "grid", placeItems: "center", opacity: tocando ? 0.75 : 1, boxShadow: "0 0 0 8px rgba(220,38,38,.25)" }}>
          {tocando ? <Pause size={20} aria-hidden /> : <Play size={34} aria-hidden />}
        </button>
      </div>
    </section>
  );
}
