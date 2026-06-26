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
  initialProgressoSeg?: number;
}

type Status = "idle" | "extracting" | "loading" | "playing" | "error";
type StreamTipo = "hls" | "mp4" | "iframe" | "native";

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
  episodioId, temporada, numeroEp, prevUrl, nextUrl, duracaoSeg, initialProgressoSeg = 0,
}: Props) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressoRef = useRef(0);
  const durationRef = useRef(duracaoSeg ?? 0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSkipDoneRef = useRef(false);
  const extractAbortRef = useRef<AbortController | null>(null);
  const isProxiedRef = useRef(false);
  const directStreamRef = useRef<string | null>(null);
  const streamRefererRef = useRef<string | null>(null);

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
  const [nextEpCountdown, setNextEpCountdown] = useState<number | null>(null);

  const fonte = allFontes[fonteIdx];

  // ── Save progress ─────────────────────────────────────────────────────────
  const saveProgress = useCallback(async () => {
    if (!progressoRef.current) return;
    await fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conteudoId, conteudoTipo, episodioId, temporada, numeroEp,
        progressoSeg: progressoRef.current,
        duracaoSeg: durationRef.current || duracaoSeg,
      }),
    }).catch(() => {});
  }, [conteudoId, conteudoTipo, episodioId, temporada, numeroEp, duracaoSeg]);

  // Salva a cada 15s + ao sair da página
  useEffect(() => {
    const t = setInterval(saveProgress, 15000);
    const onHide = () => { if (document.visibilityState === "hidden") saveProgress(); };
    const onUnload = () => saveProgress();

    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onUnload);

    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [saveProgress]);

  // ── Extract ───────────────────────────────────────────────────────────────
  const switchFonte = useCallback((idx: number) => {
    setFonteIdx(idx);
    setStatus("idle");
    setStreamUrl(null);
    setError("");
    setCurrentTime(0);
    setPlaying(false);
    autoSkipDoneRef.current = false;
    isProxiedRef.current = false;
    directStreamRef.current = null;
    streamRefererRef.current = null;
  }, []);

  const extract = useCallback(async (embedUrl: string) => {
    // Cancela qualquer extração anterior ainda em andamento
    extractAbortRef.current?.abort();
    const ctrl = new AbortController();
    extractAbortRef.current = ctrl;
    isProxiedRef.current = false;
    directStreamRef.current = null;
    streamRefererRef.current = null;

    setStatus("extracting");
    setError("");
    setStreamUrl(null);
    try {
      const res = await fetch(`/api/player/extract?url=${encodeURIComponent(embedUrl)}`, { signal: ctrl.signal });
      const data = await res.json();
      if (!res.ok || !data.stream) throw new Error(data.error || "Stream não encontrado");
      setStreamTipo(data.tipo ?? "hls");
      if (data.tipo === "iframe") {
        setStreamUrl(data.stream);
        setStatus("playing");
      } else if (data.tipo === "native") {
        // CDN bloqueia Origin header (CORS) e IPs de datacenter.
        // video.src sem crossOrigin = no-CORS request = sem Origin = CDN aceita IP residencial.
        // Funciona em Safari/iOS/Android nativamente. Desktop Chrome: fallback para iframe.
        directStreamRef.current = data.stream;
        streamRefererRef.current = data.referer ?? null; // URL do embed (iframe fallback)
        setStreamUrl(data.stream);
        setStatus("loading");
      } else {
        // Tenta direto do browser primeiro — CDNs aceitam o IP do usuário mas bloqueiam Vercel
        directStreamRef.current = data.stream;
        streamRefererRef.current = data.referer ?? null;
        setStreamUrl(data.stream);
        setStatus("loading");
      }
    } catch (e: any) {
      if ((e as any)?.name === "AbortError") return; // extração cancelada, ignora
      // Auto-pula para a próxima fonte disponível
      if (fonteIdx < allFontes.length - 1) {
        switchFonte(fonteIdx + 1);
      } else {
        setError(e.message || "Nenhuma fonte funcionou");
        setStatus("error");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonteIdx, allFontes.length, switchFonte]);

  useEffect(() => {
    if (!fonte?.embedUrl) return;
    extract(fonte.embedUrl);
  }, [fonte?.embedUrl, extract]);

  // ── HLS load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!streamUrl || !videoRef.current || streamTipo === "iframe") return;
    const video = videoRef.current;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    // "native": video.src direto sem crossOrigin → no-CORS → sem Origin header.
    // CDN aceita IPs residenciais sem Origin. Safari/iOS/Android suportam HLS nativo.
    // Desktop Chrome não suporta HLS nativo → erro → fallback para iframe com embed URL.
    if (streamTipo === "native") {
      const supportsNativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
      if (!supportsNativeHls) {
        // Desktop Chrome/Firefox: sem HLS nativo → vai direto para iframe com o embed URL
        const embedUrl = streamRefererRef.current;
        if (embedUrl) {
          setStreamTipo("iframe");
          setStreamUrl(embedUrl);
        } else if (fonteIdx < allFontes.length - 1) {
          switchFonte(fonteIdx + 1);
        } else {
          setError("Player não suportado neste browser");
          setStatus("error");
        }
        return;
      }
      // Safari / iOS / Android: HLS nativo sem CORS
      video.src = streamUrl;
      if (initialProgressoSeg > 5) {
        video.addEventListener("loadedmetadata", () => { video.currentTime = initialProgressoSeg; }, { once: true });
      }
      video.play().catch(() => {});
      // Fallback: se nativo falhar mesmo assim, tenta iframe
      const onNativeError = () => {
        const embedUrl = streamRefererRef.current;
        if (embedUrl) { setStreamTipo("iframe"); setStreamUrl(embedUrl); }
        else if (fonteIdx < allFontes.length - 1) { switchFonte(fonteIdx + 1); }
        else { setError("Erro no stream"); setStatus("error"); }
      };
      video.addEventListener("error", onNativeError, { once: true });
      return () => { video.removeEventListener("error", onNativeError); };
    }

    const isHls = streamUrl.includes(".m3u8") || streamUrl.includes(".txt") || streamUrl.includes("proxy");

    if (isHls) {
      import("hls.js").then(({ default: Hls }) => {
        if (!Hls.isSupported()) { video.src = streamUrl!; video.play().catch(() => {}); return; }
        const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 90 });
        hlsRef.current = hls;
        hls.loadSource(streamUrl!);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (initialProgressoSeg > 5) video.currentTime = initialProgressoSeg;
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_: any, data: any) => {
          if (data.fatal) {
            const direct = directStreamRef.current;
            if (!isProxiedRef.current && direct) {
              // Fallback: tenta via proxy com Referer correto para validação da CDN
              isProxiedRef.current = true;
              const ref = streamRefererRef.current;
              const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : "";
              setStreamUrl(`/api/player/proxy?url=${encodeURIComponent(direct)}${refParam}`);
            } else if (fonteIdx < allFontes.length - 1) {
              switchFonte(fonteIdx + 1);
            } else {
              setError("Erro no stream HLS");
              setStatus("error");
            }
          }
        });
      });
    } else {
      video.src = streamUrl;
      if (initialProgressoSeg > 5) {
        video.addEventListener("loadedmetadata", () => { video.currentTime = initialProgressoSeg; }, { once: true });
      }
      video.play().catch(() => {});
    }
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [streamUrl, streamTipo, fonteIdx, allFontes.length, switchFonte]);

  // ── Video events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => { setPlaying(true); setStatus("playing"); };
    const onPause = () => { setPlaying(false); saveProgress(); };
    const onWaiting = () => setStatus("loading");
    const onCanPlay = () => setStatus("playing");
    const onTimeUpdate = () => {
      const ct = video.currentTime;
      const dur = video.duration;
      setCurrentTime(ct);
      progressoRef.current = Math.floor(ct);
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));

      // Auto-skip próximo episódio quando faltam ≤ 20s
      if (nextUrl && isFinite(dur) && dur > 0 && (dur - ct) <= 20 && !autoSkipDoneRef.current) {
        const remaining = Math.ceil(dur - ct);
        setNextEpCountdown(remaining);
        if (remaining <= 0) {
          autoSkipDoneRef.current = true;
          setNextEpCountdown(null);
          saveProgress().then(() => router.push(nextUrl));
        }
      } else if (nextEpCountdown !== null && (dur - ct) > 20) {
        setNextEpCountdown(null);
      }
    };
    const onDurationChange = () => {
      if (isFinite(video.duration)) {
        setDuration(video.duration);
        durationRef.current = video.duration;
      }
    };
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextUrl, nextEpCountdown, saveProgress]);

  // ── Auto-hide controls ────────────────────────────────────────────────────
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
        onClick={streamTipo !== "iframe" && streamTipo !== "native" ? togglePlay : undefined}
      >
        {streamTipo === "iframe" && streamUrl ? (
          <iframe
            key={streamUrl}
            src={streamUrl}
            className="w-full h-full border-0"
            allowFullScreen
            allow="autoplay; fullscreen; picture-in-picture"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
          />
        ) : (
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            playsInline
            preload="auto"
          />
        )}

        {/* Extracting */}
        {status === "extracting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm gap-4">
            <Loader2 size={44} className="animate-spin text-[#E50914]" strokeWidth={1.5} />
            <p className="text-white/70 text-xs uppercase tracking-widest">Obtendo stream</p>
          </div>
        )}

        {/* Loading */}
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 size={36} className="animate-spin text-white/50" strokeWidth={1.5} />
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 gap-5">
            <AlertCircle size={44} className="text-[#E50914]" strokeWidth={1.5} />
            <p className="text-white/80 text-sm max-w-xs text-center leading-relaxed">{error}</p>
            <button
              onClick={(e) => { e.stopPropagation(); extract(fonte?.embedUrl ?? ""); }}
              className="bg-white text-black text-xs font-bold px-5 py-2.5 rounded-full hover:bg-zinc-200 transition"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {status === "idle" && allFontes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-white/30 text-sm">Nenhuma fonte disponível</p>
          </div>
        )}

        {/* ── Auto-skip próximo episódio ── */}
        {nextEpCountdown !== null && nextUrl && (
          <div className="absolute bottom-28 right-6 z-30 flex items-center gap-3 bg-black/80 backdrop-blur border border-white/10 rounded-xl px-4 py-3 shadow-xl">
            <div className="text-right">
              <p className="text-white/60 text-[10px] uppercase tracking-wider">Próximo episódio em</p>
              <p className="text-white font-bold text-2xl tabular-nums leading-none">{nextEpCountdown}s</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => { autoSkipDoneRef.current = true; setNextEpCountdown(null); saveProgress().then(() => router.push(nextUrl)); }}
                className="flex items-center gap-1.5 bg-[#E50914] hover:bg-[#f00] text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition"
              >
                Ir agora <ChevronRight size={14} />
              </button>
              <button
                onClick={() => { autoSkipDoneRef.current = true; setNextEpCountdown(null); }}
                className="text-white/40 hover:text-white/70 text-[10px] text-center transition"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom controls ── */}
      <div
        className={`absolute bottom-0 inset-x-0 z-20 flex flex-col gap-2 px-4 pb-5 pt-20 bg-gradient-to-t from-black via-black/70 to-transparent transition-opacity duration-300 ${ctrlVisible}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Fontes */}
        {allFontes.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            {allFontes.map((f, i) => (
              <button
                key={i}
                onClick={() => switchFonte(i)}
                className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-all ${
                  fonteIdx === i
                    ? "bg-[#E50914] border-[#E50914] text-white font-semibold"
                    : "border-white/20 text-white/50 hover:border-white/40 hover:text-white/80 bg-white/5"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {/* Barra de progresso */}
        <div className="relative w-full cursor-pointer group/bar" style={{ height: 18 }}>
          <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-white/15 group-hover/bar:h-[5px] transition-all duration-150">
            <div className="absolute inset-0 rounded-full bg-white/20" style={{ width: `${bufPct}%` }} />
            <div className="absolute inset-0 rounded-full bg-[#E50914]" style={{ width: `${pct}%` }}>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 rounded-full bg-white shadow-md opacity-0 group-hover/bar:opacity-100 transition-opacity" />
            </div>
          </div>
          <input
            type="range" min={0} max={duration || 100} step={0.5} value={currentTime}
            onChange={onSeekSlider}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
        </div>

        {/* Linha de controles */}
        <div className="flex items-center gap-1">
          <button onClick={() => seek(-10)} className="p-1.5 text-white/60 hover:text-white transition-colors">
            <SkipBack size={17} strokeWidth={1.5} />
          </button>
          <button onClick={togglePlay} className="p-1.5 text-white hover:scale-110 transition-transform">
            {playing
              ? <Pause size={26} fill="currentColor" strokeWidth={0} />
              : <Play size={26} fill="currentColor" strokeWidth={0} />
            }
          </button>
          <button onClick={() => seek(10)} className="p-1.5 text-white/60 hover:text-white transition-colors">
            <SkipForward size={17} strokeWidth={1.5} />
          </button>

          {/* Volume */}
          <div className="flex items-center group/vol ml-1">
            <button onClick={toggleMute} className="p-1.5 text-white/60 hover:text-white transition-colors">
              {muted || volume === 0 ? <VolumeX size={17} strokeWidth={1.5} /> : <Volume2 size={17} strokeWidth={1.5} />}
            </button>
            <div className="overflow-hidden w-0 group-hover/vol:w-20 transition-all duration-200 ease-out">
              <input
                type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
                onChange={onVolumeSlider}
                className="w-20 accent-[#E50914] cursor-pointer"
              />
            </div>
          </div>

          <span className="text-white/40 text-[11px] font-mono ml-2 shrink-0">
            {fmt(currentTime)} <span className="text-white/20">/</span> {fmt(duration)}
          </span>

          <div className="flex-1" />

          {prevUrl && (
            <button
              onClick={() => { saveProgress(); router.push(prevUrl); }}
              className="flex items-center gap-0.5 text-[11px] text-white/50 hover:text-white transition-colors px-1"
            >
              <ChevronLeft size={13} strokeWidth={2} /> Ant.
            </button>
          )}
          {nextUrl && (
            <button
              onClick={() => { saveProgress(); router.push(nextUrl); }}
              className="flex items-center gap-0.5 text-[11px] text-white/80 hover:text-white border border-white/20 hover:bg-white/10 px-2.5 py-1 rounded-full transition-all"
            >
              Próximo <ChevronRight size={13} strokeWidth={2} />
            </button>
          )}

          <button onClick={toggleFullscreen} className="p-1.5 text-white/60 hover:text-white transition-colors ml-1">
            <Maximize size={17} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
