"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  X, ChevronLeft, ChevronRight, Play, Pause,
  Volume2, VolumeX, Maximize, Loader2, AlertCircle,
  SkipBack, SkipForward,
} from "lucide-react";
import { useRouter } from "next/navigation";

interface Props {
  urlDub: string | null;
  urlLeg: string | null;
  titulo: string;
  conteudoId: string;
  conteudoTipo: "filme" | "serie";
  episodioId?: string;
  temporada?: number;
  numeroEp?: number;
  prevUrl?: string;
  nextUrl?: string;
  duracaoSeg?: number;
}

type Status = "idle" | "extracting" | "loading" | "playing" | "error";
type StreamTipo = "hls" | "mp4" | "iframe";

interface Fonte {
  label: string;
  embedUrl: string;
}

function parseFontes(urls: string | null, prefix: string): Fonte[] {
  if (!urls) return [];
  return urls.split(",").map((u, i) => ({
    label: `${prefix} ${i + 1}`,
    embedUrl: u.trim(),
  })).filter((f) => f.embedUrl);
}

function fmt(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export function CustomPlayer({
  urlDub, urlLeg, titulo, conteudoId, conteudoTipo,
  episodioId, temporada, numeroEp, prevUrl, nextUrl, duracaoSeg,
}: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressoRef = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build fonte list: DUB first, then LEG
  const allFontes: Fonte[] = [
    ...parseFontes(urlDub, "[Dub]"),
    ...parseFontes(urlLeg, "[Leg]"),
  ];

  const [fonteIdx, setFonteIdx] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamTipo, setStreamTipo] = useState<StreamTipo>("hls");

  // Player controls state
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(duracaoSeg ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const fonte = allFontes[fonteIdx];

  // ── Extract stream from embed URL ─────────────────────────────────────────
  const extract = useCallback(async (embedUrl: string) => {
    setStatus("extracting");
    setError("");
    setStreamUrl(null);

    try {
      const res = await fetch(`/api/player/extract?url=${encodeURIComponent(embedUrl)}`);
      const data = await res.json();
      if (!res.ok || !data.stream) throw new Error(data.error || "Stream não encontrado");
      setStreamTipo(data.tipo ?? "hls");
      if (data.tipo === "iframe") {
        // Embed que não suporta extração server-side — usa iframe direto
        setStreamUrl(data.stream);
        setStatus("playing");
      } else {
        // Passa pelo proxy para contornar CORS do CDN
        const proxied = `/api/player/proxy?url=${encodeURIComponent(data.stream)}`;
        setStreamUrl(proxied);
        setStatus("loading");
      }
    } catch (e: any) {
      setError(e.message || "Erro ao extrair stream");
      setStatus("error");
    }
  }, []);

  // Extract when fonte changes
  useEffect(() => {
    if (!fonte?.embedUrl) return;
    extract(fonte.embedUrl);
  }, [fonte?.embedUrl, extract]);

  // ── Load HLS when streamUrl changes ──────────────────────────────────────
  useEffect(() => {
    if (!streamUrl || !videoRef.current) return;

    const video = videoRef.current;

    // Destroy previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const isHls = streamUrl.includes(".m3u8");

    if (isHls) {
      import("hls.js").then(({ default: Hls }) => {
        if (!Hls.isSupported()) {
          // Safari native HLS
          video.src = streamUrl;
          video.play().catch(() => {});
          return;
        }
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 90,
        });
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_: any, data: any) => {
          if (data.fatal) {
            setError("Erro no stream HLS");
            setStatus("error");
          }
        });
      });
    } else {
      video.src = streamUrl;
      video.play().catch(() => {});
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [streamUrl]);

  // ── Video events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => { setPlaying(true); setStatus("playing"); };
    const onPause = () => setPlaying(false);
    const onWaiting = () => setStatus("loading");
    const onCanPlay = () => setStatus("playing");
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      progressoRef.current = Math.floor(video.currentTime);
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onDurationChange = () => {
      if (isFinite(video.duration)) setDuration(video.duration);
    };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onFullscreenChange = () => setFullscreen(!!document.fullscreenElement);

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("volumechange", onVolumeChange);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("volumechange", onVolumeChange);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  // ── Save progress ─────────────────────────────────────────────────────────
  const saveProgress = useCallback(async () => {
    if (!progressoRef.current) return;
    await fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conteudoId, conteudoTipo, episodioId,
        temporada, numeroEp,
        progressoSeg: progressoRef.current,
        duracaoSeg: duration || duracaoSeg,
      }),
    }).catch(() => {});
  }, [conteudoId, conteudoTipo, episodioId, temporada, numeroEp, duration, duracaoSeg]);

  useEffect(() => {
    const t = setInterval(saveProgress, 15000);
    return () => clearInterval(t);
  }, [saveProgress]);

  // ── Auto-hide controls ────────────────────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (playing) setShowControls(false);
    }, 3000);
  }, [playing]);

  useEffect(() => {
    resetHideTimer();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [playing, resetHideTimer]);

  // ── Control actions ───────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    v.paused ? v.play() : v.pause();
  };

  const seek = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.currentTime + delta, v.duration || 0));
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  };

  const onVolumeSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Number(e.target.value);
    v.muted = Number(e.target.value) === 0;
  };

  const onSeekSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Number(e.target.value);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  const switchFonte = (idx: number) => {
    setFonteIdx(idx);
    setStatus("idle");
    setStreamUrl(null);
    setError("");
    setCurrentTime(0);
    setPlaying(false);
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      if (e.code === "ArrowRight") seek(10);
      if (e.code === "ArrowLeft") seek(-10);
      if (e.code === "KeyF") toggleFullscreen();
      if (e.code === "KeyM") toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufPct = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black flex flex-col select-none"
      onMouseMove={resetHideTimer}
      onTouchStart={resetHideTimer}
    >
      {/* ── Top bar ── */}
      <div className={`flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent z-10 transition-opacity duration-300 ${showControls ? "opacity-100" : "opacity-0"}`}>
        <button onClick={() => { saveProgress(); router.back(); }} className="text-white hover:text-zinc-300 transition p-1">
          <X size={22} />
        </button>
        <span className="text-white font-semibold text-sm truncate max-w-xs md:max-w-xl text-center">
          {titulo}{temporada && numeroEp ? ` — T${temporada} EP${numeroEp}` : ""}
        </span>
        <div className="w-8" />
      </div>

      {/* ── Video ── */}
      <div className="flex-1 relative flex items-center justify-center cursor-pointer" onClick={streamTipo !== "iframe" ? togglePlay : undefined}>
        {streamTipo === "iframe" && streamUrl ? (
          <iframe
            key={streamUrl}
            src={streamUrl}
            className="w-full h-full border-0"
            allowFullScreen
            allow="autoplay; fullscreen; picture-in-picture"
          />
        ) : (
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            playsInline
            preload="auto"
          />
        )}

        {/* Status overlay */}
        {status === "extracting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-3">
            <Loader2 size={48} className="animate-spin text-red-500" />
            <p className="text-white text-sm">Obtendo stream…</p>
          </div>
        )}
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 size={40} className="animate-spin text-white/60" />
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 gap-4">
            <AlertCircle size={48} className="text-red-500" />
            <p className="text-white text-sm max-w-sm text-center">{error}</p>
            <div className="flex gap-3">
              <button
                onClick={(e) => { e.stopPropagation(); extract(fonte?.embedUrl ?? ""); }}
                className="bg-white text-black text-sm font-bold px-5 py-2 rounded hover:bg-zinc-200 transition"
              >
                Tentar novamente
              </button>
              {allFontes.length > 1 && fonteIdx < allFontes.length - 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); switchFonte(fonteIdx + 1); }}
                  className="bg-zinc-700 text-white text-sm px-5 py-2 rounded hover:bg-zinc-600 transition"
                >
                  Próxima fonte
                </button>
              )}
            </div>
          </div>
        )}

        {/* Center play/pause flash */}
        {status === "idle" && allFontes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-zinc-500 text-sm">Nenhuma fonte disponível</p>
          </div>
        )}
      </div>

      {/* ── Bottom controls ── */}
      <div className={`flex flex-col gap-2 px-4 pb-4 pt-2 bg-gradient-to-t from-black/90 to-transparent z-10 transition-opacity duration-300 ${showControls ? "opacity-100" : "opacity-0"}`}>

        {/* Progress bar */}
        <div className="relative w-full h-1 group/bar cursor-pointer" onClick={(e) => e.stopPropagation()}>
          {/* Buffer */}
          <div className="absolute inset-0 rounded-full bg-white/20">
            <div className="h-full bg-white/30 rounded-full" style={{ width: `${bufPct}%` }} />
          </div>
          {/* Progress */}
          <div className="absolute inset-0 rounded-full pointer-events-none">
            <div className="h-full bg-red-500 rounded-full" style={{ width: `${pct}%` }} />
          </div>
          <input
            type="range"
            min={0}
            max={duration || 100}
            step={0.5}
            value={currentTime}
            onChange={onSeekSlider}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>

        {/* Controls row */}
        <div className="flex items-center justify-between gap-4" onClick={(e) => e.stopPropagation()}>

          {/* Left: play/skip/time */}
          <div className="flex items-center gap-3">
            <button onClick={() => seek(-10)} className="text-white/70 hover:text-white transition">
              <SkipBack size={20} />
            </button>
            <button onClick={togglePlay} className="text-white hover:text-zinc-300 transition">
              {playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
            </button>
            <button onClick={() => seek(10)} className="text-white/70 hover:text-white transition">
              <SkipForward size={20} />
            </button>
            <span className="text-white/70 text-xs font-mono">
              {fmt(currentTime)} / {fmt(duration)}
            </span>
          </div>

          {/* Center: fontes + DUB/LEG */}
          <div className="flex items-center gap-1.5 flex-wrap justify-center">
            {allFontes.map((f, i) => (
              <button
                key={i}
                onClick={() => switchFonte(i)}
                className={`text-xs px-2.5 py-1 rounded transition ${
                  fonteIdx === i
                    ? "bg-red-600 text-white font-bold"
                    : "bg-white/10 text-white/70 hover:bg-white/20"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Right: volume + nav + fullscreen */}
          <div className="flex items-center gap-3">
            {prevUrl && (
              <button onClick={() => { saveProgress(); router.push(prevUrl); }} className="flex items-center gap-1 text-xs text-white/70 hover:text-white transition">
                <ChevronLeft size={16} /> Anterior
              </button>
            )}
            {nextUrl && (
              <button onClick={() => { saveProgress(); router.push(nextUrl); }} className="flex items-center gap-1 text-xs text-white bg-white/10 hover:bg-white/20 px-2.5 py-1 rounded transition">
                Próximo <ChevronRight size={16} />
              </button>
            )}
            <button onClick={toggleMute} className="text-white/70 hover:text-white transition">
              {muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={onVolumeSlider}
              className="w-20 accent-red-500 cursor-pointer"
            />
            <button onClick={toggleFullscreen} className="text-white/70 hover:text-white transition">
              <Maximize size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
