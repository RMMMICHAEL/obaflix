"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { X, ChevronLeft, ChevronRight, Play, AlertCircle, RotateCcw, Cast } from "lucide-react";
import { useRouter } from "next/navigation";

// ── Loading dots ───────────────────────────────────────────────────────────────
function BouncingDots({ size = "md" }: { size?: "sm" | "md" }) {
  const sz = size === "sm" ? "w-2 h-2" : "w-3 h-3";
  return (
    <div className="flex gap-2 items-center">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`rounded-full bg-[#E50914] ${sz} animate-bounce`}
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

// ── JW Player loader (singleton, loads script once) ────────────────────────────
const JW_CDN = "https://ssl.p.jwpcdn.com/player/v/8.19.1/jwplayer.js";
// Licença encontrada no app Megaflix desktop (resources/app.asar → player page)
const JW_KEY = "64HPbvSQorQcd52B8XFuhMtEoitbvY/EXJmMBfKcXZQU2Rnn";
let jwLoaded = false;
let jwLoading = false;
const jwQueue: (() => void)[] = [];

function loadJW(cb: () => void) {
  if (jwLoaded) { cb(); return; }
  jwQueue.push(cb);
  if (jwLoading) return;
  jwLoading = true;
  const s = document.createElement("script");
  s.src = JW_CDN;
  s.onload = () => { jwLoaded = true; jwLoading = false; jwQueue.forEach((fn) => fn()); jwQueue.length = 0; };
  document.head.appendChild(s);
}

// ── Types ──────────────────────────────────────────────────────────────────────
interface Props {
  urlDub: string | null;
  urlLeg: string | null;
  titulo: string;
  thumbUrl?: string;
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

interface Fonte { label: string; embedUrl: string; }

function isRola34Url(url: string) {
  return /\/(rola3|rola4)\//.test(url) || /embedplayer/.test(url) || /xn--kcksk7a2bl5le7b6doc1h3f/.test(url);
}

// Monta a URL do proxy para o path nativo Electron (rola3/4 via IPC, CDN com IP do usuário).
// "native=1" identifica explicitamente esse path para o interceptor do main.js, que precisa
// diferenciá-lo do path web/W3 (URLs assinadas com "sig", que devem passar pelo Vercel).
function buildElectronProxyUrl(cdnUrl: string, referer?: string | null) {
  const ref = referer ? `&ref=${encodeURIComponent(referer)}` : "";
  return `/api/player/proxy?url=${encodeURIComponent(cdnUrl)}&native=1${ref}`;
}

function parseFontes(urls: string | null, prefix: string, includeRola34: boolean): Fonte[] {
  if (!urls) return [];
  return urls.split(",")
    .map((u) => u.trim())
    .filter((u) => u && (includeRola34 || !isRola34Url(u)))
    .map((u, i) => ({ label: `${prefix} ${i + 1}`, embedUrl: u }));
}

// ── Component ──────────────────────────────────────────────────────────────────
export function CustomPlayer({
  urlDub, urlLeg, titulo, thumbUrl, conteudoId, conteudoTipo,
  episodioId, temporada, numeroEp, prevUrl, nextUrl, duracaoSeg, initialProgressoSeg = 0,
}: Props) {
  const router = useRouter();

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);   // native tipo only (rola4/Safari)
  const jwRef = useRef<any>(null);                   // JW Player instance
  const progressoRef = useRef(0);
  const durationRef = useRef(duracaoSeg ?? 0);
  const autoSkipDoneRef = useRef(false);
  // [DIAG] timestamp do último load() — para medir intervalo até o primeiro erro/warning pós-renovação
  const lastLoadAtRef = useRef(0);
  const extractAbortRef = useRef<AbortController | null>(null);
  const isProxiedRef = useRef(false);
  const directStreamRef = useRef<string | null>(null);
  const streamRefererRef = useRef<string | null>(null);
  const reExtractCountRef = useRef(0); // falhas consecutivas de renovação por fonte (reseta a cada play bem-sucedido)
  const reExtractingRef = useRef(false); // impede re-extrações concorrentes (vários "error" do hls.js em sequência)
  const reExtractDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null); // debounce antes de iniciar renovação
  const reExtractGenerationRef = useRef(0); // monotônico — identifica cada chamada de runReExtract; resposta com geração antiga é descartada
  const suppressErrorUntilRef = useRef(0); // timestamp (ms) até quando "error" do JW deve ser ignorado (eco tardio da mídia anterior pós-load())
  const lastReExtractSuccessAtRef = useRef(0); // timestamp (ms) da última renovação bem-sucedida — usado pro cooldown mínimo
  const userAudioTrackRef = useRef<number | null>(null); // null = sem escolha manual; senão, índice escolhido pelo usuário — mantido durante todo o episódio (até remontagem por key={episodio.id})
  const isChangingAudioTrackRef = useRef(false); // impede re-entrada no handler audioTracks: setCurrentAudioTrack() dispara audioTracks de forma síncrona → sem essa flag entra em recursão infinita
  // Stable refs to avoid stale closures in JW Player callbacks
  const saveProgressRef = useRef<() => Promise<void>>(async () => {});
  const switchFonteRef = useRef<(idx: number) => void>(() => {});
  const nextUrlRef = useRef(nextUrl);
  const nextEpCountdownActiveRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRetryDoneRef = useRef(false);
  const extractRef = useRef<(url: string) => void>(() => {});
  const castContextRef = useRef<any>(null);
  // Guarda desmontagem: impede setState/callbacks após unmount e durante navegação auto-skip
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      extractAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => { nextUrlRef.current = nextUrl; }, [nextUrl]);

  // No Electron (.exe): inclui rola3/rola4 como players principais
  // No site: remove rola3/rola4 (só funcionam com IP residencial via app nativo)
  const isDesktop = typeof window !== "undefined" && !!(window as any).obaflixDesktop;

  const allFontes: Fonte[] = [
    ...parseFontes(urlDub, "[Dub]", isDesktop),
    ...parseFontes(urlLeg, "[Leg]", isDesktop),
  ];

  const [fonteIdx, setFonteIdx] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamTipo, setStreamTipo] = useState<StreamTipo>("hls");
  // native tipo states
  const [nativePlaying, setNativePlaying] = useState(false);
  const [autoPlayBlocked, setAutoPlayBlocked] = useState(false);
  const [nextEpCountdown, setNextEpCountdown] = useState<number | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  // chromecast
  const [castAvailable, setCastAvailable] = useState(false);
  const [isCasting, setIsCasting] = useState(false);

  const fonte = allFontes[fonteIdx];

  // ── Chromecast SDK ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Chromecast não funciona no Electron — evita session_error no .exe
    if ((window as any).obaflixDesktop) return;
    // __onGCastApiAvailable é chamado pelo SDK assim que ele carrega
    (window as any).__onGCastApiAvailable = (isAvailable: boolean) => {
      if (!isAvailable) return;
      const castApi = (window as any).cast;
      const chromeApi = (window as any).chrome;
      const ctx = castApi.framework.CastContext.getInstance();
      ctx.setOptions({
        receiverApplicationId: chromeApi.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chromeApi.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      castContextRef.current = ctx;
      setCastAvailable(true);
      const ss = castApi.framework.SessionState;
      ctx.addEventListener(
        castApi.framework.CastContextEventType.SESSION_STATE_CHANGED,
        (e: any) => {
          if (e.sessionState === ss.SESSION_STARTED || e.sessionState === ss.SESSION_RESUMED) {
            setIsCasting(true);
          } else if (e.sessionState === ss.SESSION_ENDED) {
            setIsCasting(false);
            // retoma o player local quando a transmissão encerra
            if (jwRef.current) { try { jwRef.current.play(); } catch { /**/ } }
          }
        }
      );
    };
    // Carrega SDK apenas uma vez por página
    if (!(window as any).__castSdkInjected) {
      (window as any).__castSdkInjected = true;
      const s = document.createElement("script");
      s.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
      document.head.appendChild(s);
    }
  }, []);

  // ── handleCast ───────────────────────────────────────────────────────────────
  const handleCast = async () => {
    const ctx = castContextRef.current;
    if (!ctx) return;
    if (isCasting) { ctx.endCurrentSession(true); return; }

    const url = directStreamRef.current || streamUrl;
    if (!url) return;

    try {
      await ctx.requestSession();
      const session = ctx.getCurrentSession();
      if (!session) return;

      const chromeApi = (window as any).chrome;
      const mediaInfo = new chromeApi.cast.media.MediaInfo(url, "application/vnd.apple.mpegurl");
      const meta = new chromeApi.cast.media.GenericMediaMetadata();
      meta.title = titulo;
      if (thumbUrl) meta.images = [{ url: thumbUrl }];
      mediaInfo.metadata = meta;

      const loadReq = new chromeApi.cast.media.LoadRequest(mediaInfo);
      if (progressoRef.current > 5) loadReq.currentTime = progressoRef.current;

      await session.loadMedia(loadReq);
      // pausa o player local para evitar áudio duplo
      if (jwRef.current) { try { jwRef.current.pause(); } catch { /**/ } }
    } catch (err: any) {
      if (err?.code !== "CANCEL") console.error("[CAST]", err);
    }
  };

  // ── Save progress ────────────────────────────────────────────────────────────
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

  saveProgressRef.current = saveProgress;

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

  // ── switchFonte ──────────────────────────────────────────────────────────────
  const switchFonte = useCallback((idx: number) => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    if (reExtractDebounceRef.current) { clearTimeout(reExtractDebounceRef.current); reExtractDebounceRef.current = null; }
    if (jwRef.current) { try { jwRef.current.remove(); } catch {} jwRef.current = null; }
    setFonteIdx(idx);
    setStatus("idle");
    setStreamUrl(null);
    setError("");
    setShowRetry(false);
    setNativePlaying(false);
    setAutoPlayBlocked(false);
    setNextEpCountdown(null);
    autoSkipDoneRef.current = false;
    autoRetryDoneRef.current = false;
    nextEpCountdownActiveRef.current = false;
    isProxiedRef.current = false;
    directStreamRef.current = null;
    streamRefererRef.current = null;
    reExtractCountRef.current = 0;
    reExtractingRef.current = false;
    suppressErrorUntilRef.current = 0;
    lastReExtractSuccessAtRef.current = 0;
    isChangingAudioTrackRef.current = false;
  }, []);

  switchFonteRef.current = switchFonte;

  // ── Extract ──────────────────────────────────────────────────────────────────
  const extract = useCallback(async (embedUrl: string) => {
    extractAbortRef.current?.abort();
    const ctrl = new AbortController();
    extractAbortRef.current = ctrl;
    isProxiedRef.current = false;
    directStreamRef.current = null;
    streamRefererRef.current = null;
    setAutoPlayBlocked(false);
    setStatus("extracting");
    setError("");
    setStreamUrl(null);
    try {
      const desktop = typeof window !== "undefined" && (window as any).obaflixDesktop;
      let tipo: string;
      let playerUrl: string;

      if (desktop && isRola34Url(embedUrl)) {
        // Electron: extração nativa via IPC (IP residencial do usuário)
        const data: { stream?: string; tipo?: string; referer?: string; error?: string } =
          await desktop.extractStream(embedUrl);
        if (data.error || !data.stream) throw new Error(data.error || "Stream não encontrado");
        tipo = data.tipo ?? "hls";
        // No Electron, usamos a URL direta (DevTools do Electron é local, não exposto)
        playerUrl = tipo === "iframe" ? data.stream! : buildElectronProxyUrl(data.stream!, data.referer);
        streamRefererRef.current = data.referer ?? null;
        directStreamRef.current = data.stream!;
      } else {
        // Web: obtém play token primeiro, depois extrai
        const tokenRes = await fetch("/api/player/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embedUrl }),
          signal: ctrl.signal,
        });
        if (!tokenRes.ok) throw new Error("Falha ao obter autorização de reprodução");
        const { playToken } = await tokenRes.json();

        const extractRes = await fetch(
          `/api/player/extract?url=${encodeURIComponent(embedUrl)}&playToken=${encodeURIComponent(playToken)}`,
          { signal: ctrl.signal },
        );
        const data = await extractRes.json();
        if (!extractRes.ok) throw new Error(data.error || "Stream não encontrado");

        tipo = data.tipo ?? "hls";
        if (tipo === "iframe") {
          playerUrl = data.stream!;
        } else {
          if (!data.streamToken) throw new Error("Stream não encontrado");
          // Stream token opaco → CDN URL nunca exposta no browser
          playerUrl = `/api/player/proxy?t=${encodeURIComponent(data.streamToken)}`;
        }
        directStreamRef.current = playerUrl;
      }

      setStreamTipo(tipo as StreamTipo);
      if (tipo === "iframe") {
        setStreamUrl(playerUrl);
        setStatus("playing");
      } else {
        setStreamUrl(playerUrl);
        setStatus("loading");
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      if (fonteIdx < allFontes.length - 1) {
        switchFonte(fonteIdx + 1);
      } else {
        setError(e.message || "Nenhuma fonte funcionou");
        setStatus("error");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonteIdx, allFontes.length, switchFonte]);

  extractRef.current = extract;

  useEffect(() => {
    if (!fonte?.embedUrl) return;
    extract(fonte.embedUrl);
  }, [fonte?.embedUrl, extract]);

  // ── JW Player setup (hls / mp4) ──────────────────────────────────────────────
  useEffect(() => {
    if (!streamUrl || streamTipo === "iframe" || streamTipo === "native") return;

    // Destroy previous player if any
    if (jwRef.current) { try { jwRef.current.remove(); } catch {} jwRef.current = null; }

    // Ensure container div exists and is empty
    const container = document.getElementById("jw-player-container");
    if (!container) return;
    container.innerHTML = "";

    // streamUrl já é /api/player/proxy?t=<token> (stream token opaco) ou URL do Electron
    const fileType = streamTipo === "mp4" ? "mp4" : "hls";

    // Fonte única pelo proxy autenticado — CDN URL nunca exposta ao browser
    const sources: any[] = [{ file: streamUrl, type: fileType }];

    const titleText = `${titulo}${temporada && numeroEp ? ` · T${temporada} EP${numeroEp}` : ""}`;

    loadJW(() => {
      // Componente pode ter desmontado enquanto o script JW carregava
      if (unmountedRef.current) return;
      const jw = (window as any).jwplayer;
      if (!jw) return;
      jw.key = JW_KEY;

      const player = jw("jw-player-container").setup({
        sources,
        image: thumbUrl || undefined,
        controls: true,
        sharing: false,
        playbackRateControls: [0.5, 1, 1.5, 2],
        autostart: true,
        displaytitle: true,
        displaydescription: true,
        title: titleText,
        description: "Você está assistindo",
        skin: { name: "netflix" },
        hls: { bufferingGoal: 80 },
        width: "100%",
        height: "100%",
        stretching: "uniform",
      });

      jwRef.current = player;

      // Seek to resume position on initial load
      if (initialProgressoSeg > 5) {
        player.once("firstFrame", () => { player.seek(initialProgressoSeg); });
      }

      // Retry automático: 8s sem play → 1 re-extração silenciosa; se ainda travar → mostra botão
      // autoRetryDoneRef é resetado apenas no switchFonte (troca de fonte), não em re-extração
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      setShowRetry(false);
      retryTimerRef.current = setTimeout(() => {
        if (unmountedRef.current) return;
        const state = jwRef.current?.getState?.();
        if (!state || state === "playing" || state === "paused") return;
        if (!autoRetryDoneRef.current) {
          autoRetryDoneRef.current = true;
          extractRef.current(fonte?.embedUrl ?? "");
        } else {
          setShowRetry(true);
        }
      }, 8000);

      player.on("play", () => {
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        setShowRetry(false);
        setStatus("playing");
        // Renovação anterior teve sucesso (player voltou a reproduzir) — reseta o contador
        // de falhas consecutivas. Sem isso, um episódio longo com várias renovações bem-sucedidas
        // ao longo de horas estouraria o cap de 5 e cairia em erro mesmo sem nenhuma falha real.
        reExtractCountRef.current = 0;
      });
      player.on("pause", () => { saveProgressRef.current(); });
      player.on("complete", () => { saveProgressRef.current(); });

      player.on("time", ({ position, duration }: any) => {
        if (unmountedRef.current) return;
        progressoRef.current = Math.floor(position);
        if (isFinite(duration) && duration > 0) durationRef.current = duration;

        const url = nextUrlRef.current;
        if (!url || autoSkipDoneRef.current || !isFinite(duration) || duration <= 0) return;

        const remaining = duration - position;
        if (remaining <= 20) {
          const secs = Math.ceil(remaining);
          setNextEpCountdown(secs);
          nextEpCountdownActiveRef.current = true;
          if (secs <= 0) {
            autoSkipDoneRef.current = true;
            setNextEpCountdown(null);
            nextEpCountdownActiveRef.current = false;
            saveProgressRef.current().then(() => router.push(url));
          }
        } else if (nextEpCountdownActiveRef.current) {
          setNextEpCountdown(null);
          nextEpCountdownActiveRef.current = false;
        }
      });

      // ── Wrapper seguro para setCurrentAudioTrack ───────────────────────────
      // setCurrentAudioTrack() dispara "audioTracks" de forma síncrona dentro
      // da própria chamada — sem isChangingAudioTrackRef, o handler seria
      // re-entrado antes de retornar, causando recursão infinita (RangeError:
      // Maximum call stack size exceeded). O finally garante que a flag é
      // sempre liberada mesmo que setCurrentAudioTrack lance.
      function safeSetAudioTrack(desired: number) {
        if (isChangingAudioTrackRef.current) return; // re-entrada: o JW disparou o evento dentro de setCurrentAudioTrack — ignora
        if (player.getCurrentAudioTrack() === desired) return; // já está na faixa certa — não dispara o evento desnecessariamente
        isChangingAudioTrackRef.current = true;
        try {
          player.setCurrentAudioTrack(desired);
        } finally {
          isChangingAudioTrackRef.current = false;
        }
      }

      // ── Auto-seleciona áudio em português, exceto se o usuário já escolheu manualmente ──
      // Dispara na carga inicial e após cada load() de renovação de token.
      // userAudioTrackRef = null → nenhuma escolha manual ainda → aplica preferência PT.
      // userAudioTrackRef = N   → usuário escolheu manualmente → restaura exatamente
      //                          essa faixa, sem jamais sobrescrever por PT novamente
      //                          durante o mesmo episódio.
      player.on("audioTracks", () => {
        if (unmountedRef.current) return;
        const tracks: any[] = player.getAudioTracks() ?? [];
        if (tracks.length <= 1) return;

        if (userAudioTrackRef.current !== null) {
          // Escolha manual já registrada — restaura sem sobrescrever.
          // Índice pode ser inválido se o novo stream tiver menos faixas (ex.: renovação
          // com playlist diferente); nesse caso mantém o que o player escolheu.
          if (userAudioTrackRef.current < tracks.length) {
            safeSetAudioTrack(userAudioTrackRef.current);
          }
          return;
        }

        // Sem escolha manual: auto-seleciona PT como padrão inicial do episódio.
        const ptIdx = tracks.findIndex((t: any) => {
          const n = (t.name || t.label || t.language || "").toLowerCase();
          return n.includes("pt") || n.includes("por") || n.includes("portugu");
        });
        if (ptIdx > 0) safeSetAudioTrack(ptIdx);
      });

      // ── Botão de alternância de áudio na barra de controles ────────────────
      const audioSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
      player.addButton(audioSvg, "Alternar áudio", () => {
        const tracks: any[] = player.getAudioTracks() ?? [];
        if (tracks.length <= 1) return;
        const cur = player.getCurrentAudioTrack();
        const next = (cur + 1) % tracks.length;
        userAudioTrackRef.current = next; // registra escolha manual para este episódio
        safeSetAudioTrack(next);
      }, "obaflix-audio-toggle");

      // Renova o token CDN (rola3/4 no Electron) de forma transparente: extrai uma nova
      // URL via IPC nativo e troca a fonte do player sem destruí-lo, preservando posição,
      // faixa de áudio e legenda. Protegida por debounce + lock + timeout de segurança.
      const REEXTRACT_BASE_DELAY_MS = 500;
      const REEXTRACT_MAX_DELAY_MS = 8000; // backoff exponencial: 500ms → 1s → 2s → 4s → 8s (cap)
      const REEXTRACT_SAFETY_TIMEOUT_MS = 18000; // > timeout interno do main.js (15s)
      const REEXTRACT_MAX_CONSECUTIVE_FAILURES = 5;
      const REEXTRACT_MIN_COOLDOWN_MS = 5000; // erro tão pouco tempo após uma renovação bem-sucedida provavelmente não é token expirado

      // Delay antes da próxima tentativa, crescendo com o nº de falhas consecutivas já
      // ocorridas nesta sequência (reExtractCountRef ainda não foi incrementado p/ esta tentativa).
      function getReExtractDelay() {
        const failedAttempts = reExtractCountRef.current;
        return Math.min(REEXTRACT_BASE_DELAY_MS * 2 ** failedAttempts, REEXTRACT_MAX_DELAY_MS);
      }

      function runReExtract(embedUrl: string, fi: number, len: number) {
        reExtractingRef.current = true;
        reExtractCountRef.current += 1;
        const attempt = reExtractCountRef.current;
        const pos = progressoRef.current;
        const desktop = (window as any).obaflixDesktop;

        // requestId da renovação + identidade do player no início da chamada. Se, enquanto
        // extractStream() está em voo, o efeito for limpo (troca de fonte/episódio recria o
        // player), tanto a geração quanto a referência ficam desatualizadas — a resposta tardia
        // é descartada e NUNCA é aplicada sobre o player/conteúdo errado.
        const myGeneration = ++reExtractGenerationRef.current;
        const playerAtStart = jwRef.current;

        console.log(`[reextract] #${attempt} (gen=${myGeneration}) iniciando renovação de token — pos=${pos}s`);

        let settled = false;
        const fail = () => {
          if (unmountedRef.current) return;
          if (reExtractGenerationRef.current !== myGeneration) return; // superado por nova tentativa/troca
          if (fi < len - 1) switchFonteRef.current(fi + 1);
          else { setError("Erro no stream"); setStatus("error"); }
        };

        const safetyTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reExtractingRef.current = false;
          console.warn(`[reextract] #${attempt} (gen=${myGeneration}) timeout de segurança (${REEXTRACT_SAFETY_TIMEOUT_MS}ms) — extractStream não respondeu`);
          fail();
        }, REEXTRACT_SAFETY_TIMEOUT_MS);

        desktop.extractStream(embedUrl)
          .then((data: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(safetyTimer);
            if (unmountedRef.current) return;

            // Resposta obsoleta: ou uma geração mais nova já assumiu, ou o player desta
            // chamada não é mais o player ativo (fonte/episódio mudou nesse meio-tempo).
            // Mesmo conteúdo == mesmo embedUrl (fixo nesta chamada) + mesma instância do player.
            if (reExtractGenerationRef.current !== myGeneration || jwRef.current !== playerAtStart) {
              console.log(`[reextract] #${attempt} (gen=${myGeneration}) descartado — player/geração mudou durante a extração`);
              return;
            }

            if (!data?.stream) {
              // extractStream nunca rejeita (sempre resolve, com {error} em caso de falha) —
              // sem este tratamento explícito o player ficava travado sem nenhum fallback.
              console.warn(`[reextract] #${attempt} falhou: ${data?.error || "stream vazio"}`);
              fail();
              return;
            }

            console.log(`[reextract] #${attempt} sucesso — retomando em ${pos}s`);
            const newUrl = buildElectronProxyUrl(data.stream, data.referer);

            // [DIAG] Contexto da renovação — remover após confirmar causa dos 500 em .woff
            const prevItem = jwRef.current.getPlaylistItem?.();
            const prevRawUrl: string = prevItem?.file || prevItem?.sources?.[0]?.file || "desconhecido";
            const newManifestDomain = (() => { try { return new URL(data.stream).hostname; } catch { return "?"; } })();
            console.log(`[diag/renewal] URL anterior (proxy): ${prevRawUrl.slice(0, 120)}`);
            console.log(`[diag/renewal] URL nova (proxy):     ${newUrl.slice(0, 120)}`);
            console.log(`[diag/renewal] Domínio CDN novo:     ${newManifestDomain}`);
            console.log(`[diag/renewal] gen=${myGeneration} pos=${pos}s attempt=${attempt}`);

            // Ignora "error" pelos próximos instantes: hls.js pode emitir eventos atrasados
            // da instância anterior (ligada à mídia antiga) logo depois do load().
            suppressErrorUntilRef.current = Date.now() + 2000;
            lastReExtractSuccessAtRef.current = Date.now();
            lastLoadAtRef.current = Date.now(); // [DIAG] marca timestamp do load() para medir latência até o primeiro erro
            jwRef.current.load([{ file: newUrl, type: "hls" }]);
            if (pos > 5) {
              jwRef.current.once("firstFrame", () => {
                if (!jwRef.current) return;
                // Alguns provedores retornam playlist com duração levemente diferente após
                // renovar o token — um seek() além da duração real pode gerar comportamento
                // inesperado no hls.js. Só restaura a posição se ela couber no novo stream.
                const dur = jwRef.current.getDuration?.();
                const validDuration = typeof dur === "number" && isFinite(dur) && dur > 0;
                if (!validDuration || pos < dur) {
                  jwRef.current.seek(pos);
                } else {
                  console.warn(`[reextract] posição salva (${pos}s) >= duração do novo stream (${dur}s) — seek ignorado`);
                }
              });
            }
            jwRef.current.play();
          })
          .catch((err: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(safetyTimer);
            console.warn(`[reextract] #${attempt} (gen=${myGeneration}) erro inesperado:`, err?.message);
            fail();
          })
          .finally(() => {
            reExtractingRef.current = false;
          });
      }

      // [DIAG] Captura warnings do JW Player (333500/334001/330000) com URL do recurso que falhou
      // Ajuda a confirmar se .woff 500 são de fontes do manifesto HLS ou do skin do JW Player
      // Remover após confirmar causa raiz dos erros de renovação
      player.on("warning", (e: any) => {
        if (unmountedRef.current) return;
        const msSinceLoad = lastLoadAtRef.current > 0 ? Date.now() - lastLoadAtRef.current : -1;
        const srcUrl: string = e?.sourceError?.url || e?.url || "";
        const domain = srcUrl ? (() => { try { return new URL(srcUrl).hostname; } catch { return srcUrl.slice(0, 40); } })() : "n/a";
        console.warn(`[diag/warning] JW ${e?.code} (+${msSinceLoad}ms pós-load) — domínio: ${domain} — msg: ${e?.message || ""}`);
      });

      player.on("error", (e: any) => {
        if (unmountedRef.current) return;

        // [DIAG] Timing e detalhe do erro — remover após confirmar causa raiz
        const msSinceLoad = lastLoadAtRef.current > 0 ? Date.now() - lastLoadAtRef.current : -1;
        const srcUrl: string = e?.sourceError?.url || e?.url || "";
        const domain = srcUrl ? (() => { try { return new URL(srcUrl).hostname; } catch { return srcUrl.slice(0, 40); } })() : "n/a";
        console.warn(`[diag/error] JW ${e?.code || "?"} (+${msSinceLoad}ms pós-load) — domínio: ${domain} — msg: ${e?.message || ""}`);

        // Eco tardio da mídia anterior: hls.js às vezes dispara "error" da instância antiga
        // poucos instantes depois do load() já ter trocado a fonte. Ignorar evita reextrações
        // desnecessárias disparadas por uma falha que não pertence mais à mídia atual.
        if (Date.now() < suppressErrorUntilRef.current) {
          console.log("[reextract] ignorando error tardio (eco da mídia anterior pós-load)");
          return;
        }

        const fi = fonteIdx;
        const len = allFontes.length;
        const embedUrl = fonte?.embedUrl ?? "";
        const inElectron = typeof window !== "undefined" && !!(window as any).obaflixDesktop;

        // rola3/rola4 no Electron: token CDN expirou → re-extrai silenciosamente
        // sem destruir o player (sem overlay, sem troca de fonte).
        if (inElectron && isRola34Url(embedUrl) && reExtractCountRef.current < REEXTRACT_MAX_CONSECUTIVE_FAILURES) {
          // Se o episódio ainda não começou a reproduzir (pos < 5s), o erro provavelmente
          // não é token expirado (que só ocorre no meio do stream após minutos/horas), mas
          // sim fonte inválida para este episódio (URL inexistente, CDN offline, etc.).
          // Re-extrair a mesma URL retornaria o mesmo CDN com o mesmo problema e apenas
          // adicionaria 500ms+ de overlay de erro antes de falhar de novo. Vai direto para
          // a próxima fonte para recuperação mais rápida — cobre o caso de auto-avanço de
          // episódio onde o primeiro frame ainda não chegou.
          if (progressoRef.current < 5) {
            console.log(`[reextract] pos=${progressoRef.current}s — sem progresso de reprodução; provável fonte inválida, não token expirado → próxima fonte`);
            if (fi < len - 1) switchFonteRef.current(fi + 1);
            else { setError("Erro no stream"); setStatus("error"); }
            return;
          }

          // Cooldown mínimo: se o erro aconteceu poucos segundos depois da última renovação
          // bem-sucedida, provavelmente não é token expirado de novo — é outro problema
          // (ex.: CDN instável). Renovar de imediato aqui só alimentaria um loop. Escala
          // direto para o fallback em vez de gastar outra extração.
          const sinceLastSuccess = Date.now() - lastReExtractSuccessAtRef.current;
          if (lastReExtractSuccessAtRef.current > 0 && sinceLastSuccess < REEXTRACT_MIN_COOLDOWN_MS) {
            console.warn(`[reextract] erro ${sinceLastSuccess}ms após última renovação bem-sucedida — não parece token expirado, pulando nova extração`);
            if (fi < len - 1) switchFonteRef.current(fi + 1);
            else { setError("Erro no stream"); setStatus("error"); }
            return;
          }

          // Debounce com backoff exponencial: hls.js dispara "error" várias vezes em sequência
          // rápida para a mesma falha (oscilação do CDN) — aguarda um silêncio crescente a cada
          // falha consecutiva antes de tentar de novo, em vez de bater no servidor repetidamente.
          if (reExtractDebounceRef.current) clearTimeout(reExtractDebounceRef.current);
          const delay = getReExtractDelay();
          reExtractDebounceRef.current = setTimeout(() => {
            reExtractDebounceRef.current = null;
            if (unmountedRef.current || reExtractingRef.current) return;
            runReExtract(embedUrl, fi, len);
          }, delay);
          return;
        }

        if (fi < len - 1) {
          switchFonteRef.current(fi + 1);
        } else {
          setError("Erro no stream");
          setStatus("error");
        }
      });
    });

    return () => {
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      if (reExtractDebounceRef.current) { clearTimeout(reExtractDebounceRef.current); reExtractDebounceRef.current = null; }
      if (jwRef.current) { try { jwRef.current.remove(); } catch {} jwRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, streamTipo]);

  // ── Native HLS (rola4 em Safari/iOS) ────────────────────────────────────────
  useEffect(() => {
    if (!streamUrl || !videoRef.current || streamTipo !== "native") return;
    const video = videoRef.current;

    const supportsNativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (!supportsNativeHls) {
      const refUrl = streamRefererRef.current;
      // rola3: embed URL é página HTML funcional → iframe. rola4: embed retorna 404 → pula fonte.
      if (refUrl) { setStreamTipo("iframe"); setStreamUrl(refUrl); return; }
      if (fonteIdx < allFontes.length - 1) { switchFonte(fonteIdx + 1); return; }
      setError("Player não suportado neste browser"); setStatus("error");
      return;
    }

    video.src = streamUrl;
    if (initialProgressoSeg > 5) {
      video.addEventListener("loadedmetadata", () => { video.currentTime = initialProgressoSeg; }, { once: true });
    }
    video.play().catch(() => setAutoPlayBlocked(true));

    const onNativeError = () => {
      const refUrl = streamRefererRef.current;
      if (refUrl) { setStreamTipo("iframe"); setStreamUrl(refUrl); return; }
      if (fonteIdx < allFontes.length - 1) { switchFonte(fonteIdx + 1); return; }
      setError("Erro no stream"); setStatus("error");
    };
    video.addEventListener("error", onNativeError, { once: true });
    return () => { video.removeEventListener("error", onNativeError); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, streamTipo]);

  // ── Native video events ──────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || streamTipo !== "native") return;

    const onPlay = () => { setNativePlaying(true); setStatus("playing"); setAutoPlayBlocked(false); };
    const onPause = () => { setNativePlaying(false); saveProgress(); };
    const onWaiting = () => setStatus("loading");
    const onCanPlay = () => setStatus("playing");
    const onTimeUpdate = () => {
      const ct = video.currentTime;
      const dur = video.duration;
      progressoRef.current = Math.floor(ct);
      if (isFinite(dur)) durationRef.current = dur;

      const url = nextUrl;
      if (!url || autoSkipDoneRef.current || !isFinite(dur) || dur <= 0) return;
      const remaining = dur - ct;
      if (remaining <= 20) {
        const secs = Math.ceil(remaining);
        setNextEpCountdown(secs);
        nextEpCountdownActiveRef.current = true;
        if (secs <= 0) {
          autoSkipDoneRef.current = true;
          setNextEpCountdown(null);
          nextEpCountdownActiveRef.current = false;
          saveProgress().then(() => router.push(url));
        }
      } else if (nextEpCountdownActiveRef.current) {
        setNextEpCountdown(null);
        nextEpCountdownActiveRef.current = false;
      }
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("timeupdate", onTimeUpdate);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamTipo, nextUrl, saveProgress]);

  const titleText = `${titulo}${temporada && numeroEp ? ` · T${temporada} EP${numeroEp}` : ""}`;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col select-none">
      {/* ── Top bar – above JW Player ── */}
      <div className="absolute top-0 inset-x-0 z-[9999] flex items-center gap-2 px-4 pt-3 pb-10 bg-gradient-to-b from-black/80 to-transparent pointer-events-none">
        <button
          className="pointer-events-auto text-white/80 hover:text-white transition-colors p-1 rounded-full hover:bg-white/10 flex-shrink-0"
          onClick={() => { saveProgress(); router.back(); }}
        >
          <X size={22} strokeWidth={1.5} />
        </button>
        <div className="flex-1" />
        {/* Fontes */}
        {allFontes.length > 0 && (
          <div className="pointer-events-auto flex items-center gap-1.5 flex-wrap justify-end">
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
        {prevUrl && (
          <button
            className="pointer-events-auto flex items-center gap-0.5 text-[11px] text-white/50 hover:text-white transition-colors px-1 ml-1"
            onClick={() => { saveProgress(); router.push(prevUrl); }}
          >
            <ChevronLeft size={13} strokeWidth={2} /> Ant.
          </button>
        )}
        {nextUrl && (
          <button
            className="pointer-events-auto flex items-center gap-0.5 text-[11px] text-white/80 hover:text-white border border-white/20 hover:bg-white/10 px-2.5 py-1 rounded-full transition-all"
            onClick={() => { saveProgress(); router.push(nextUrl); }}
          >
            Próximo <ChevronRight size={13} strokeWidth={2} />
          </button>
        )}
        {/* Chromecast */}
        {castAvailable && (
          <button
            onClick={handleCast}
            title={isCasting ? "Parar transmissão" : "Transmitir no Chromecast"}
            className={`pointer-events-auto p-1.5 rounded-full border transition-all ${
              isCasting
                ? "border-[#E50914] text-[#E50914] bg-[#E50914]/10"
                : "border-white/20 text-white/50 hover:border-white/40 hover:text-white bg-white/5"
            }`}
          >
            <Cast size={14} strokeWidth={1.5} />
          </button>
        )}
      </div>

      {/* ── Main video area ── */}
      <div className="flex-1 relative">
        {/* iframe */}
        {streamTipo === "iframe" && streamUrl ? (
          <iframe
            key={streamUrl}
            src={streamUrl}
            className="absolute inset-0 w-full h-full border-0"
            allow="autoplay; fullscreen; picture-in-picture"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
          />
        ) : streamTipo === "native" ? (
          /* Native video (rola4 em Safari/iOS sem CORS) */
          <video
            ref={videoRef}
            className="absolute inset-0 w-full h-full object-contain"
            playsInline
            preload="auto"
          />
        ) : (
          /* JW Player container — dangerouslySetInnerHTML previne conflito de removeChild
             entre o reconciliador do React e as mutações de DOM do JW Player */
          <div
            id="jw-player-container"
            className="absolute inset-0 w-full h-full"
            dangerouslySetInnerHTML={{ __html: "" }}
          />
        )}

        {/* ── Extracting overlay: backdrop + título + dots ── */}
        {status === "extracting" && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center">
            {thumbUrl && (
              <div
                className="absolute inset-0 bg-cover bg-center scale-105"
                style={{ backgroundImage: `url(${thumbUrl})` }}
              />
            )}
            <div className="absolute inset-0 bg-black/75" />
            <div className="relative z-10 flex flex-col items-center gap-5 text-center px-8">
              <div className="flex flex-col items-center gap-1">
                <p className="text-white/40 text-[10px] uppercase tracking-[0.25em] font-medium">
                  Você está assistindo
                </p>
                <p className="text-white font-bold text-lg md:text-xl leading-snug">{titleText}</p>
              </div>
              <BouncingDots />
            </div>
          </div>
        )}

        {/* ── Native buffering ── */}
        {status === "loading" && streamTipo === "native" && !autoPlayBlocked && (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <BouncingDots size="sm" />
          </div>
        )}

        {/* ── Autoplay bloqueado (native) ── */}
        {autoPlayBlocked && streamTipo === "native" && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center cursor-pointer"
            onClick={() => {
              videoRef.current?.play().then(() => setAutoPlayBlocked(false)).catch(() => {});
            }}
          >
            <div className="w-20 h-20 rounded-full bg-black/50 backdrop-blur-sm border border-white/20 flex items-center justify-center hover:bg-white/10 transition-colors">
              <Play size={38} fill="white" strokeWidth={0} className="ml-1" />
            </div>
          </div>
        )}

        {/* ── Retry: player travou sem erro explícito ── */}
        {showRetry && status !== "error" && status !== "extracting" && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50">
            <button
              onClick={() => {
                setShowRetry(false);
                if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
                extractRef.current(fonte?.embedUrl ?? "");
              }}
              className="flex flex-col items-center gap-3 text-white/70 hover:text-white transition-colors group"
            >
              <div className="w-16 h-16 rounded-full bg-white/10 border border-white/20 flex items-center justify-center group-hover:bg-white/20 transition-colors">
                <RotateCcw size={26} strokeWidth={1.5} />
              </div>
              <span className="text-sm font-medium">Tentar novamente</span>
            </button>
          </div>
        )}

        {/* ── Error ── */}
        {status === "error" && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/75 gap-5">
            <AlertCircle size={44} className="text-[#E50914]" strokeWidth={1.5} />
            <p className="text-white/80 text-sm max-w-xs text-center leading-relaxed">{error}</p>
            <button
              onClick={() => extract(fonte?.embedUrl ?? "")}
              className="bg-white text-black text-xs font-bold px-5 py-2.5 rounded-full hover:bg-zinc-200 transition"
            >
              Tentar novamente
            </button>
          </div>
        )}

        {/* ── No fontes ── */}
        {status === "idle" && allFontes.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <p className="text-white/30 text-sm">Nenhuma fonte disponível</p>
          </div>
        )}

        {/* ── Auto-skip próximo episódio ── */}
        {nextEpCountdown !== null && nextUrl && (
          <div className="absolute bottom-20 right-6 z-30 flex items-center gap-3 bg-black/80 backdrop-blur border border-white/10 rounded-xl px-4 py-3 shadow-xl">
            <div className="text-right">
              <p className="text-white/60 text-[10px] uppercase tracking-wider">Próximo episódio em</p>
              <p className="text-white font-bold text-2xl tabular-nums leading-none">{nextEpCountdown}s</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => {
                  autoSkipDoneRef.current = true;
                  setNextEpCountdown(null);
                  nextEpCountdownActiveRef.current = false;
                  saveProgress().then(() => router.push(nextUrl));
                }}
                className="flex items-center gap-1.5 bg-[#E50914] hover:bg-[#f00] text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition"
              >
                Ir agora <ChevronRight size={14} />
              </button>
              <button
                onClick={() => {
                  autoSkipDoneRef.current = true;
                  setNextEpCountdown(null);
                  nextEpCountdownActiveRef.current = false;
                }}
                className="text-white/40 hover:text-white/70 text-[10px] text-center transition"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
