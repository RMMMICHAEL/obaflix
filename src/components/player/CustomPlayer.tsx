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

  const allFontes: Fonte[] = [
    ...parseFontes(urlDub, "[Dub]"),
    ...parseFontes(urlLeg, "[Leg]"),
  ];

  const [fonteIdx, setFonteIdx] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamTipo, setStreamTipo] = useState<StreamTipo>("hls");

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(duracaoSeg ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const fonte = allFontes[fonteIdx];

  // ── Extract ───────────────────────────────────────────────────────────────
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
        setStreamUrl(data.stream);
        setStatus("playing");
      } else {
        const proxied = `/api/player/proxy?url=${encodeURIComponent(data.stream)}`;
        setStreamUrl(proxied);
        setStatus("loading");
      }
    } catch (e: any) {
      setError(e.message || "Erro ao extrair stream");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (!fonte?.embedUrl) return;
    extract(fonte.embedUrl);
  }, [fonte?.embedUrl, extract]);

  // ── HLS load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!streamUrl || !videoRef.current || streamTipo === "iframe") return;
    const video = videoRef.current;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const isHls = streamUrl.includes(".m3u8") || streamUrl.includes(".txt") || streamUrl.includes("proxy");

    if (isHls) {
      import("hls.js").then(({ default: Hls }) => {
        if (!Hls.isSupported()) { video.src = streamUrl; video.play().catch(() => {}); return; }
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 90 });
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
        hls.on(Hls.Events.ERROR, (_: any, data: any) => {
          if (data.fatal) { setError("Erro no stream HLS"); setStatus("error"); }
        });
      });
    } else {
      video.src = streamUrl;
      video.play().catch(() => {});
    }
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [streamUrl, streamTipo]);

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
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onDurationChange = () => { if (isFinite(video.duration)) setDuration(video.duration); };
    const onVolumeChange = () => { setVolume(video.volume); setMuted(video.muted); };
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
      body: JSON.stringify({ conteudoId, conteudoTipo, episodioId, temporada, numeroEp, progressoSeg: progressoRef.current, duracaoSeg: duration || duracaoSeg }),
    }).catch(() => {});
  }, [conteudoId, conteudoTipo, episodioId, temporada, numeroEp, duration, duracaoSeg]);

  useEffect(() => {
    const t = setInterval(saveProgress, 15000);
    return () => clearInterval(t);
  }, [saveProgress]);

  // ── Auto-hide ─────────────────────────────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (playing) setShowControls(false); }, 3000);
  }, [playing]);

  useEffect(() => {
    resetHideTimer();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [playing, resetHideTimer]);

  // ── Controls ──────────────────────────────────────────────────────────────
  const togglePlay = () => { const v = videoRef.current; if (!v) return; v.paused ? v.play() : v.pause(); };
  const seek = (d: number) => { const v = videoRef.current; if (!v) return; v.currentTime = Math.max(0, Math.min(v.currentTime + d, v.duration || 0)); };
  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; };
  const onVolumeSlider = (e: React.ChangeEvent<HTMLInputElement>) => { const v = videoRef.current; if (!v) return; v.volume = Number(e.target.value); v.muted = Number(e.target.value) === 0; };
  const onSeekSlider = (e: React.ChangeEvent<HTMLInputElement>) => { const v = videoRef.current; if (!v) return; v.currentTime = Number(e.target.value); };
  const toggleFullscreen = () => { if (!containerRef.current) return; document.fullscreenElement ? document.exitFullscreen() : containerRef.current.requestFullscreen(); };
  const switchFonte = (idx: number) => { setFonteIdx(idx); setStatus("idle"); setStreamUrl(null); setError(""); setCurrentTime(0); setPlaying(false); };

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
  const ctrlVisible = showControls ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none";

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black flex flex-col select-none"
      onMouseMove={resetHideTimer}
      onTouchStart={resetHideTimer}
      style={{ cursor: showControls ? "default" : "none" }}
    >
      {/* ── Top bar ── */}
      <div className={`absolute top-0 inset-x-0 z-20 flex items-center justify-between px-5 pt-4 pb-16 bg-gradient-to-b from-black/80 via-black/30 to-transparent transition-opacity duration-300 ${ctrlVisible}`}>
        <button
          onClick={() => { saveProgress(); router.back(); }}
          className="text-white/80 hover:text-white transition-colors p-1 rounded-full hover:bg-white/10"
        >
          <X size={22} strokeWidth={1.5} />
        </button>
        <span className="text-white/90 font-medium text-sm tracking-wide truncate max-w-xs md:max-w-xl text-center">
          {titulo}{temporada && numeroEp ? ` · T${temporada} EP${numeroEp}` : ""}
        </span>
        <div className="w-8" />
      </div>

      {/* ── Video area ── */}
      <div
        className="flex-1 relative flex items-center justify-center"
        onClick={streamTipo !== "iframe" ? togglePlay : undefined}
      >
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

        {/* Extracting overlay */}
        {status === "extracting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm gap-4">
            <Loader2 size={44} className="animate-spin text-[#ED1D24]" strokeWidth={1.5} />
            <p className="text-white/70 text-xs uppercase tracking-widest">Obtendo stream</p>
          </div>
        )}

        {/* Loading overlay */}
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 size={36} className="animate-spin text-white/50" strokeWidth={1.5} />
          </div>
        )}

        {/* Error overlay */}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 gap-5">
            <AlertCircle size={44} className="text-[#ED1D24]" strokeWidth={1.5} />
            <p className="text-white/80 text-sm max-w-xs text-center leading-relaxed">{error}</p>
            <div className="flex gap-3">
              <button
                onClick={(e) => { e.stopPropagation(); extract(fonte?.embedUrl ?? ""); }}
                className="bg-white text-black text-xs font-bold px-5 py-2.5 rounded-full hover:bg-zinc-200 transition"
              >
                Tentar novamente
              </button>
              {allFontes.length > 1 && fonteIdx < allFontes.length - 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); switchFonte(fonteIdx + 1); }}
                  className="border border-white/20 text-white text-xs px-5 py-2.5 rounded-full hover:bg-white/10 transition"
                >
                  Próxima fonte
                </button>
              )}
            </div>
          </div>
        )}

        {status === "idle" && allFontes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-white/30 text-sm">Nenhuma fonte disponível</p>
          </div>
        )}
      </div>

      {/* ── Bottom controls ── */}
      <div className={`absolute bottom-0 inset-x-0 z-20 flex flex-col gap-3 px-5 pb-5 pt-20 bg-gradient-to-t from-black/90 via-black/40 to-transparent transition-opacity duration-300 ${ctrlVisible}`}>

        {/* Progress bar */}
        <div
          className="relative w-full group/bar cursor-pointer"
          style={{ height: "4px" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Track */}
          <div className="absolute inset-0 rounded-full bg-white/20 transition-all duration-150 group-hover/bar:h-[6px] group-hover/bar:-top-[1px]">
            {/* Buffer */}
            <div className="absolute inset-0 rounded-full bg-white/25" style={{ width: `${bufPct}%` }} />
            {/* Progress */}
            <div className="absolute inset-0 rounded-full bg-[#ED1D24]" style={{ width: `${pct}%` }}>
              {/* Thumb */}
              <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 rounded-full bg-white shadow opacity-0 group-hover/bar:opacity-100 transition-opacity" />
            </div>
          </div>
          <input
            type="range" min={0} max={duration || 100} step={0.5} value={currentTime}
            onChange={onSeekSlider}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>

        {/* Controls row */}
        <div
          className="flex items-center justify-between gap-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Left: playback */}
          <div className="flex items-center gap-3">
            <button onClick={() => seek(-10)} className="text-white/60 hover:text-white transition-colors">
              <SkipBack size={19} strokeWidth={1.5} />
            </button>
            <button onClick={togglePlay} className="text-white hover:text-white/80 transition-colors">
              {playing
                ? <Pause size={28} fill="currentColor" strokeWidth={0} />
                : <Play size={28} fill="currentColor" strokeWidth={0} />
              }
            </button>
            <button onClick={() => seek(10)} className="text-white/60 hover:text-white transition-colors">
              <SkipForward size={19} strokeWidth={1.5} />
            </button>
            <span className="text-white/50 text-xs font-mono tracking-wider">
              {fmt(currentTime)} <span className="text-white/25">/</span> {fmt(duration)}
            </span>
          </div>

          {/* Center: fontes */}
          <div className="flex items-center gap-1.5 flex-wrap justify-center">
            {allFontes.map((f, i) => (
              <button
                key={i}
                onClick={() => switchFonte(i)}
                className={`text-xs px-3 py-1 rounded-full border transition-all ${
                  fonteIdx === i
                    ? "bg-[#ED1D24] border-[#ED1D24] text-white font-semibold"
                    : "border-white/15 text-white/50 hover:border-white/30 hover:text-white/80"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Right: volume + nav + fullscreen */}
          <div className="flex items-center gap-3">
            {prevUrl && (
              <button
                onClick={() => { saveProgress(); router.push(prevUrl); }}
                className="flex items-center gap-1 text-xs text-white/50 hover:text-white transition-colors"
              >
                <ChevronLeft size={15} strokeWidth={1.5} /> Anterior
              </button>
            )}
            {nextUrl && (
              <button
                onClick={() => { saveProgress(); router.push(nextUrl); }}
                className="flex items-center gap-1 text-xs text-white border border-white/20 hover:bg-white/10 px-3 py-1 rounded-full transition-all"
              >
                Próximo <ChevronRight size={15} strokeWidth={1.5} />
              </button>
            )}

            {/* Volume */}
            <div className="flex items-center gap-2 group/vol">
              <button onClick={toggleMute} className="text-white/60 hover:text-white transition-colors">
                {muted || volume === 0
                  ? <VolumeX size={19} strokeWidth={1.5} />
                  : <Volume2 size={19} strokeWidth={1.5} />
                }
              </button>
              <div className="w-0 overflow-hidden group-hover/vol:w-20 transition-all duration-200">
                <input
                  type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
                  onChange={onVolumeSlider}
                  className="w-20 accent-[#ED1D24] cursor-pointer"
                />
              </div>
            </div>

            <button onClick={toggleFullscreen} className="text-white/60 hover:text-white transition-colors">
              <Maximize size={19} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
