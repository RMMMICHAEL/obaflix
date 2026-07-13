"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Play, AlertCircle, RotateCcw, Cast, Film, Flag } from "lucide-react";
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
  nomeEpisodio?: string;
  thumbUrl?: string;
  logoUrl?: string | null;
  sinopse?: string | null;
  conteudoId: string;
  conteudoTipo: "filme" | "serie";
  tmdbId?: string | null;
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

interface Fonte { label: string; embedUrl: string; tokenized: boolean; }

// Identifica players que utilizam URLs temporárias com token CDN (rola3/rola4).
// Usado exclusivamente pelo parseFontes para classificar fontes no momento da criação:
// essas fontes só aparecem quando isDesktop=true (não funcionam com IP de datacenter).
function isTokenizedUrl(url: string) {
  return /\/(rola3|rola4)\//.test(url) || /embedplayer/.test(url) || /xn--kcksk7a2bl5le7b6doc1h3f/.test(url);
}

// Providers com extrator nativo no Electron/Android (desktop/electron/extractors.js e
// StreamExtractor.kt) — reproduzem direto do CDN com IP residencial do usuário, sem
// proxy de segmentos pela Vercel. Superset de isTokenizedUrl: cobre também PlayHide,
// LuluVid, Rola2 (legado /rola/), Wish, Bolt e Big. Ao contrário de isTokenizedUrl, NÃO
// afeta quais fontes aparecem no site web — só decide, quando isDesktop=true, se a
// extração usa o bridge nativo (desktop.extractStream) em vez do fluxo web via Vercel.
// Ver docs/player-native-extraction.md para o mapa completo e como adicionar um novo player.
function supportsNativeDesktopExtraction(url: string) {
  if (isTokenizedUrl(url)) return true;
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname.includes("lulu")) return true;
    if (hostname.includes("hide")) return true;
    if (hostname.includes("wish")) return true;
    if (hostname.includes("llanfair") || pathname.includes("/rola/")) return true;
    if (hostname.includes("bolt")) return true;
    if (hostname.includes("bigshare") || hostname.includes("big")) return true;
    if (hostname.includes("watchplayer")) return true;
    return false;
  } catch {
    return false;
  }
}

// Monta a URL do proxy para o path nativo Electron (rola3/4 via IPC, CDN com IP do usuário).
// "native=1" identifica explicitamente esse path para o interceptor do main.js, que precisa
// diferenciá-lo do path web/W3 (URLs assinadas com "sig", que devem passar pelo Vercel).
function buildElectronProxyUrl(cdnUrl: string, referer?: string | null) {
  const ref = referer ? `&ref=${encodeURIComponent(referer)}` : "";
  return `/api/player/proxy?url=${encodeURIComponent(cdnUrl)}&native=1${ref}`;
}

function parseFontes(urls: string | null, prefix: string, includeTokenized: boolean): Fonte[] {
  if (!urls) return [];
  return urls.split(",")
    .map((u) => u.trim())
    .filter((u) => u && (includeTokenized || !isTokenizedUrl(u)))
    .map((u, i) => ({ label: `${prefix} ${i + 1}`, embedUrl: u, tokenized: isTokenizedUrl(u) }));
}

// Extrai o hostname real de uma URL de erro do JW Player.
// No path Electron (native=1), srcUrl tem forma https://obaflix.vercel.app/api/player/proxy?url=<cdnUrl>&native=1 —
// o hostname relevante está dentro do parâmetro url=, não no proxy.
function diagDomain(srcUrl: string): string {
  if (!srcUrl) return "n/a";
  try {
    const u = new URL(srcUrl);
    const inner = u.searchParams.get("url");
    return new URL(inner || srcUrl).hostname;
  } catch {
    return srcUrl.slice(0, 40);
  }
}

// Emite um log de recuperação padronizado com prefixo único [recovery].
// Campos fixos em todos os caminhos: reason, gen, attempt, fi, pos, sinceRenewal, detail.
function recoveryLog(
  level: "log" | "warn",
  reason: string,
  gen: number | null,
  attempt: number | null,
  fi: number,
  len: number,
  pos: number,
  sinceRenewal: number,
  detail: string,
) {
  const msg = [
    "[recovery]",
    `reason=${reason}`,
    `gen=${gen ?? "-"}`,
    `attempt=${attempt ?? "-"}`,
    `fi=${fi}/${len - 1}`,
    `pos=${pos}s`,
    `sinceRenewal=${sinceRenewal >= 0 ? `${sinceRenewal}ms` : "never"}`,
    `→ ${detail}`,
  ].join("  ");
  level === "warn" ? console.warn(msg) : console.log(msg);
}

// ── Component ──────────────────────────────────────────────────────────────────
export function CustomPlayer({
  urlDub, urlLeg, titulo, nomeEpisodio, thumbUrl, logoUrl, sinopse,
  conteudoId, conteudoTipo, tmdbId,
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
  // Representa "nenhum frame válido foi exibido ainda" para esta fonte.
  // Definido true na montagem e em cada switchFonte; definido false pelo evento firstFrame
  // (sinal definitivo de frame exibido). O evento play serve apenas como fallback para
  // provedores que não disparem firstFrame.
  // Enquanto true: erros → initial-load-fallback (fonte inválida, não token expirado).
  // Enquanto false: erros → lógica normal de token-renewal.
  const initialLoadRef = useRef(true);
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

  const allFontes: Fonte[] = [];

  // Player 1: webcinevs2.com — MP4 direto via Cloudflare CDN
  if (tmdbId) {
    if (conteudoTipo === "serie" && temporada && numeroEp) {
      allFontes.push({
        label: "Player 1",
        embedUrl: `https://webcinevs2.com/watch?id=${tmdbId}&type=tv&season=${temporada}&episode=${numeroEp}&q=${encodeURIComponent(titulo)}`,
        tokenized: false,
      });
    } else if (conteudoTipo === "filme") {
      allFontes.push({
        label: "Player 1",
        embedUrl: `https://webcinevs2.com/watch?id=${tmdbId}&type=movie&q=${encodeURIComponent(titulo)}`,
        tokenized: false,
      });
    }
  }

  // Player 2: playerflix.ink → embedplayer2.xyz
  if (tmdbId) {
    if (conteudoTipo === "serie" && temporada && numeroEp) {
      allFontes.push({
        label: "Player 2",
        embedUrl: `https://playerflix.ink/pages/ajax.php?id=${tmdbId}&type=tv&season=${temporada}&episode=${numeroEp}`,
        tokenized: false,
      });
    } else if (conteudoTipo === "filme") {
      allFontes.push({
        label: "Player 2",
        embedUrl: `https://playerflix.ink/pages/ajax.php?id=${tmdbId}&type=movie`,
        tokenized: false,
      });
    }
  }

  allFontes.push(
    ...parseFontes(urlDub, "[Dub]", isDesktop),
    ...parseFontes(urlLeg, "[Leg]", isDesktop),
  );

  // WatchPlayer: fonte sintética, não vem de urlDub/urlLeg — construída a partir do
  // tmdbId. Só no Electron/Android por enquanto (isDesktop), como opção extra ao final
  // da lista, sem prioridade sobre as fontes do banco. Ver docs/player-native-extraction.md.
  if (isDesktop && tmdbId && (conteudoTipo === "filme" || (temporada && numeroEp))) {
    const watchplayerUrl = conteudoTipo === "filme"
      ? `https://watchplayer.xyz/movie/${tmdbId}`
      : `https://watchplayer.xyz/tvshow/${tmdbId}/${temporada}/${numeroEp}`;
    allFontes.push({ label: "WatchPlayer", embedUrl: watchplayerUrl, tokenized: false });
  }

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
  // sources dropdown
  const [showSources, setShowSources] = useState(false);

  const fonte = allFontes[fonteIdx];

  // ── Chromecast SDK ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Chromecast não funciona no Electron/Android — evita session_error
    // _obaflixBridge é injetado via addJavascriptInterface antes da página carregar (Android)
    // obaflixDesktop é injetado via preload (Electron)
    if ((window as any).obaflixDesktop || (window as any)._obaflixBridge) return;
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
    initialLoadRef.current = true; // nova fonte = novo ciclo de carga inicial
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

      if (desktop && supportsNativeDesktopExtraction(embedUrl)) {
        // Electron/Android: extração nativa via bridge (IP residencial do usuário)
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
          // esses players nunca servem iframe válido — iframe fallback = extração falhou
          if (embedUrl.includes("playerflix.ink") || embedUrl.includes("webcinevs2.com")) throw new Error("Stream não encontrado");
          playerUrl = data.stream!;
        } else {
          if (!data.streamToken) throw new Error("Stream não encontrado");
          // MP4: streamToken já é a URL proxy HMAC-assinada (permite range requests repetidos ao buscar posição)
          // HLS: streamToken é um token AES-GCM single-use opaco
          playerUrl = data.streamToken.startsWith("/")
            ? data.streamToken
            : `/api/player/proxy?t=${encodeURIComponent(data.streamToken)}`;
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
        description: nomeEpisodio || "Você está assistindo",
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

      // firstFrame: sinal definitivo de que um frame válido foi exibido.
      // A partir daqui erros podem indicar token expirado e passam pela lógica de renovação.
      player.on("firstFrame", () => { initialLoadRef.current = false; });

      player.on("play", () => {
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        setShowRetry(false);
        setStatus("playing");
        initialLoadRef.current = false; // fallback: garante transição caso firstFrame não dispare
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
        if (isFinite(duration) && duration > 0) durationRef.current = Math.round(duration);

        const url = nextUrlRef.current;
        if (!url || autoSkipDoneRef.current || !isFinite(duration) || duration <= 0) return;

        const remaining = duration - position;
        const credits = 30; // pula 30s antes do fim
        const triggerAt = credits + 20; // começa a mostrar 20s antes de navegar
        if (remaining <= triggerAt && duration > triggerAt + 30) {
          const secs = Math.max(0, Math.ceil(remaining - credits));
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
        const sinceRenewal = lastReExtractSuccessAtRef.current > 0
          ? Date.now() - lastReExtractSuccessAtRef.current
          : -1;
        const desktop = (window as any).obaflixDesktop;

        // Geração monotônica + referência ao player atual. Se o efeito for limpo durante
        // a extração (troca de fonte ou episódio), a resposta chega com geração/player
        // desatualizados e é descartada — nunca aplicada sobre conteúdo errado.
        const myGeneration = ++reExtractGenerationRef.current;
        const playerAtStart = jwRef.current;

        recoveryLog("log", "token-renewal", myGeneration, attempt, fi, len, pos, sinceRenewal,
          "extração iniciada");

        let settled = false;

        // Encapsula a decisão de fallback após falha: loga em [recovery] e aciona
        // source-switch ou tela de erro conforme o número de fontes restantes.
        const fail = (detail: string) => {
          if (unmountedRef.current) return;
          if (reExtractGenerationRef.current !== myGeneration) return;
          const next = fi < len - 1 ? fi + 1 : -1;
          recoveryLog("warn", "token-renewal-failed", myGeneration, attempt, fi, len, pos, sinceRenewal,
            `${detail} → ${next >= 0 ? `source-switch fi=${fi}→${next}` : "error"}`);
          if (next >= 0) switchFonteRef.current(next);
          else { setError("Erro no stream"); setStatus("error"); }
        };

        const safetyTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reExtractingRef.current = false;
          fail(`extractStream excedeu ${REEXTRACT_SAFETY_TIMEOUT_MS}ms sem resposta`);
        }, REEXTRACT_SAFETY_TIMEOUT_MS);

        desktop.extractStream(embedUrl)
          .then((data: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(safetyTimer);
            if (unmountedRef.current) return;

            // Resposta obsoleta: geração mais nova assumiu ou o player foi trocado
            // (fonte/episódio mudou durante o voo do IPC). Descarta sem aplicar.
            if (reExtractGenerationRef.current !== myGeneration || jwRef.current !== playerAtStart) {
              recoveryLog("log", "token-renewal-discarded", myGeneration, attempt, fi, len, pos, sinceRenewal,
                "player ou geração mudou durante a extração; resposta descartada");
              return;
            }

            // extractStream resolve sempre (nunca rejeita) — stream ausente = falha real.
            if (!data?.stream) {
              fail(data?.error || "stream vazio");
              return;
            }

            const newUrl = buildElectronProxyUrl(data.stream, data.referer);
            const newManifestDomain = (() => { try { return new URL(data.stream).hostname; } catch { return "?"; } })();

            // [DIAG] Contexto da renovação — remover após confirmar causa dos 500 em .woff
            const prevItem = jwRef.current.getPlaylistItem?.();
            const prevRawUrl: string = prevItem?.file || prevItem?.sources?.[0]?.file || "desconhecido";
            console.log(`[diag/renewal] URL anterior (proxy): ${prevRawUrl.slice(0, 120)}`);
            console.log(`[diag/renewal] URL nova (proxy):     ${newUrl.slice(0, 120)}`);
            console.log(`[diag/renewal] Domínio CDN novo:     ${newManifestDomain}`);

            recoveryLog("log", "token-renewal-success", myGeneration, attempt, fi, len, pos, sinceRenewal,
              `domínio=${newManifestDomain}; load+${pos > 5 ? `seek(${pos}s)` : "play"}`);

            // Suprime "error" por 2s: hls.js pode emitir eventos atrasados da instância
            // anterior logo após load() trocar a fonte.
            suppressErrorUntilRef.current = Date.now() + 2000;
            lastReExtractSuccessAtRef.current = Date.now();
            lastLoadAtRef.current = Date.now(); // [DIAG]
            jwRef.current.load([{ file: newUrl, type: "hls" }]);
            if (pos > 5) {
              jwRef.current.once("firstFrame", () => {
                if (!jwRef.current) return;
                // Alguns provedores retornam duração levemente diferente após renovar o token;
                // seek além da duração real gera comportamento inesperado no hls.js.
                const dur = jwRef.current.getDuration?.();
                const validDuration = typeof dur === "number" && isFinite(dur) && dur > 0;
                if (!validDuration || pos < dur) {
                  jwRef.current.seek(pos);
                } else {
                  recoveryLog("warn", "token-renewal-success", myGeneration, attempt, fi, len, pos, sinceRenewal,
                    `seek ignorado: pos=${pos}s >= dur=${dur}s`);
                }
              });
            }
            jwRef.current.play();
          })
          .catch((err: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(safetyTimer);
            fail(`erro inesperado: ${err?.message ?? String(err)}`);
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
        const domain = diagDomain(srcUrl);
        console.warn(`[diag/warning] JW ${e?.code} (+${msSinceLoad}ms pós-load) — domínio: ${domain} — msg: ${e?.message || ""}`);
      });

      player.on("error", (e: any) => {
        if (unmountedRef.current) return;

        // [DIAG] Timing e detalhe do erro — remover após confirmar causa raiz
        const msSinceLoad = lastLoadAtRef.current > 0 ? Date.now() - lastLoadAtRef.current : -1;
        const srcUrl: string = e?.sourceError?.url || e?.url || "";
        const httpStatus: number | undefined = e?.sourceError?.response?.status;
        const domain = diagDomain(srcUrl);
        const statusTag = httpStatus ? ` HTTP ${httpStatus}` : "";
        console.warn(`[diag/error] JW ${e?.code || "?"}${statusTag} (+${msSinceLoad}ms pós-load) — domínio: ${domain} — msg: ${e?.message || ""}`);

        if (Date.now() < suppressErrorUntilRef.current) {
          console.log("[recovery] reason=suppressed — eco tardio da mídia anterior pós-load(); ignorando");
          return;
        }

        const fi = fonteIdx;
        const len = allFontes.length;
        const embedUrl = fonte?.embedUrl ?? "";
        const pos = progressoRef.current;
        const sinceRenewal = lastReExtractSuccessAtRef.current > 0
          ? Date.now() - lastReExtractSuccessAtRef.current
          : -1;

        // Tenta próxima fonte; se não houver, exibe erro. Usado em todos os caminhos
        // que não entram em token-renewal.
        const fallback = (reason: string, level: "log" | "warn", detail: string) => {
          recoveryLog(level, reason, null, null, fi, len, pos, sinceRenewal, detail);
          if (fi < len - 1) switchFonteRef.current(fi + 1);
          else { setError("Erro no stream"); setStatus("error"); }
        };

        const inElectron = typeof window !== "undefined" && !!(window as any).obaflixDesktop;

        // Renovação de token: apenas fontes com extração nativa em Electron/Android, com
        // tentativas restantes. Qualquer outro player vai direto para fallback.
        if (inElectron && supportsNativeDesktopExtraction(embedUrl) && reExtractCountRef.current < REEXTRACT_MAX_CONSECUTIVE_FAILURES) {

          // Nenhum frame exibido ainda: fonte inválida para este episódio, não token expirado
          if (initialLoadRef.current) {
            fallback("initial-load-fallback", "log",
              `nenhum frame exibido → fi=${fi}→${fi < len - 1 ? fi + 1 : "error"}`);
            return;
          }

          // Erro logo após renovação: instabilidade de rede, não token expirado
          if (lastReExtractSuccessAtRef.current > 0 && sinceRenewal < REEXTRACT_MIN_COOLDOWN_MS) {
            fallback("cooldown-fallback", "warn",
              `${sinceRenewal}ms após renovação (<${REEXTRACT_MIN_COOLDOWN_MS}ms) → fi=${fi}→${fi < len - 1 ? fi + 1 : "error"}`);
            return;
          }

          // Token expirado mid-stream: debounce + re-extração
          if (reExtractDebounceRef.current) clearTimeout(reExtractDebounceRef.current);
          const delay = getReExtractDelay();
          recoveryLog("log", "token-renewal", null, reExtractCountRef.current + 1, fi, len, pos, sinceRenewal,
            `debounce ${delay}ms`);
          reExtractDebounceRef.current = setTimeout(() => {
            reExtractDebounceRef.current = null;
            if (unmountedRef.current || reExtractingRef.current) return;
            runReExtract(embedUrl, fi, len);
          }, delay);
          return;
        }

        // Fallback direto: fonte sem extração nativa, não-Electron, ou max-retries atingido
        fallback("source-switch", "log",
          `${supportsNativeDesktopExtraction(embedUrl) ? `max-retries=${reExtractCountRef.current}` : "non-native"} → fi=${fi}→${fi < len - 1 ? fi + 1 : "error"}`);
      });

      // ── Botão +30s no control bar (visível em fullscreen) ────────────────────
      try {
        const fwd30Icon = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='24' viewBox='0 0 32 24'><text x='0' y='18' font-size='14' font-weight='700' font-family='Arial,sans-serif' fill='white'>+30s</text></svg>`;
        player.addButton(fwd30Icon, "Avançar 30 segundos", () => {
          const pos = player.getPosition?.() ?? 0;
          const dur = player.getDuration?.() ?? 0;
          player.seek(Math.min(pos + 30, dur - 1));
        }, "obaflix-fwd30");
      } catch {}
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
      if (isFinite(dur)) durationRef.current = Math.round(dur);

      const url = nextUrl;
      if (!url || autoSkipDoneRef.current || !isFinite(dur) || dur <= 0) return;
      const remaining = dur - ct;
      const credits = 30; // pula 30s antes do fim
      const triggerAt = credits + 20;
      if (remaining <= triggerAt && dur > triggerAt + 30) {
        const secs = Math.max(0, Math.ceil(remaining - credits));
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
  const btnCls = "flex-shrink-0 w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all duration-200 bg-white/10 text-white hover:bg-white hover:text-black active:bg-white active:text-black";

  return (
    <div className="fixed inset-0 z-50 bg-black select-none touch-none">

      {/* ── Video elements (fill entire screen) ── */}
      <div
        id="jw-player-container"
        className={`absolute inset-0 w-full h-full${
          streamTipo === "native" || (streamTipo === "iframe" && !!streamUrl) ? " hidden" : ""
        }`}
        dangerouslySetInnerHTML={{ __html: "" }}
      />

      {streamTipo === "native" && (
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-contain"
          playsInline
          preload="auto"
        />
      )}

      {streamTipo === "iframe" && streamUrl && (
        <iframe
          key={streamUrl}
          src={streamUrl}
          className="absolute inset-0 w-full h-full border-0"
          allow="autoplay; fullscreen; picture-in-picture"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
        />
      )}

      {/* ── Main UI overlay (top / middle / bottom) ── */}
      <div className="absolute inset-0 flex flex-col justify-between pointer-events-none z-[9999]">

        {/* Top bar */}
        <div className="pointer-events-auto px-3 pt-2 pb-6 bg-gradient-to-b from-black/70 via-black/30 to-transparent md:px-8 md:pt-4 md:pb-10 landscape:pb-3">
          <div className="flex items-center justify-between gap-2">

            {/* Left: back + title */}
            <div className="flex items-center min-w-0 gap-2 md:gap-3">
              <button
                title="Voltar"
                className={btnCls}
                onClick={() => { saveProgress(); router.push(conteudoTipo === "filme" ? `/filme/${conteudoId}` : `/serie/${conteudoId}`); }}
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white truncate md:text-base">{titulo}</p>
                {temporada && numeroEp && (
                  <p className="text-gray-400 text-[10px] md:text-xs truncate">
                    Temporada {temporada} · Episódio {numeroEp}{nomeEpisodio ? ` — ${nomeEpisodio}` : ""}
                  </p>
                )}
              </div>
            </div>

            {/* Right: sources, cast, prev/next, report */}
            <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">

              {/* Sources dropdown (Film icon) */}
              {allFontes.length > 0 && (
                <div className="relative">
                  <button
                    title="Fonte / Qualidade"
                    className={`${btnCls}${showSources ? " !bg-white !text-black" : ""}`}
                    onClick={(e) => { e.stopPropagation(); setShowSources((s) => !s); }}
                  >
                    <Film className="w-5 h-5" />
                  </button>
                  {showSources && (
                    <div className="absolute right-0 top-full mt-2 bg-zinc-900/95 border border-white/10 rounded-xl overflow-hidden min-w-[130px] shadow-2xl">
                      {allFontes.map((f, i) => (
                        <button
                          key={i}
                          onClick={() => { switchFonte(i); setShowSources(false); }}
                          className={`w-full text-left px-4 py-2.5 text-xs transition-all ${
                            fonteIdx === i
                              ? "bg-[#E50914] text-white font-semibold"
                              : "text-white/70 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Chromecast */}
              {castAvailable && (
                <button
                  title={isCasting ? "Parar transmissão" : "Transmitir no Chromecast"}
                  className={`${btnCls}${isCasting ? " !bg-[#E50914] !text-white hover:!bg-red-600" : ""}`}
                  onClick={handleCast}
                >
                  <Cast className="w-5 h-5" />
                </button>
              )}

              {/* Prev episode */}
              {prevUrl && (
                <button
                  title="Episódio anterior"
                  className={btnCls}
                  onClick={() => { saveProgress(); router.push(prevUrl); }}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}

              {/* Next episode */}
              {nextUrl && (
                <button
                  title="Próximo episódio"
                  className={`${btnCls} !w-auto px-3 md:px-5 gap-1`}
                  onClick={() => { saveProgress(); router.push(nextUrl); }}
                >
                  <span className="hidden sm:inline text-xs md:text-sm font-medium">Próximo</span>
                  <ChevronRight className="w-5 h-5" />
                </button>
              )}

              {/* Report */}
              <button title="Reportar problema" className={btnCls}>
                <Flag className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Middle: title logo + episode info + description */}
        <div className="self-start pointer-events-none px-3 sm:px-4 md:px-12 max-w-[240px] sm:max-w-sm md:max-w-3xl lg:max-w-4xl xl:max-w-5xl [@media(max-height:540px)]:max-w-[220px] [@media(max-height:540px)]:px-2.5">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={titulo}
              className="object-contain object-left mb-2 max-h-9 max-w-[180px] sm:max-h-14 sm:max-w-[260px] md:mb-5 md:max-h-36 md:max-w-[520px] lg:max-h-44 lg:max-w-[640px] xl:max-h-52 xl:max-w-[760px] drop-shadow-lg [@media(max-height:540px)]:max-h-9 [@media(max-height:540px)]:max-w-[165px] [@media(max-height:540px)]:mb-1"
            />
          ) : (
            <p className="text-white font-bold text-xl md:text-3xl mb-2 md:mb-4 drop-shadow-lg [@media(max-height:540px)]:text-base [@media(max-height:540px)]:mb-1">
              {titulo}
            </p>
          )}
          {temporada && numeroEp && (
            <p className="mb-1.5 text-xs font-medium text-[#E50914] sm:text-sm md:text-lg drop-shadow [@media(max-height:540px)]:text-[9px] [@media(max-height:540px)]:mb-0.5">
              Temporada {temporada} · Episódio {numeroEp}{nomeEpisodio ? ` — ${nomeEpisodio}` : ""}
            </p>
          )}
          {sinopse && (
            <p className="text-xs leading-relaxed text-gray-200/90 line-clamp-3 sm:text-sm md:text-lg md:leading-relaxed [@media(max-height:540px)]:text-[8px] [@media(max-height:540px)]:leading-tight">
              {sinopse}
            </p>
          )}
        </div>

        {/* Bottom spacer — JW Player renders its own controls here */}
        <div className="h-16 md:h-20 pointer-events-auto" />
      </div>

      {/* ── Status overlays (above main UI) ── */}

      {/* Extracting */}
      {status === "extracting" && (
        <div className="absolute inset-0 z-[99999] flex flex-col items-center justify-center">
          {thumbUrl && (
            <div className="absolute inset-0 bg-cover bg-center scale-105" style={{ backgroundImage: `url(${thumbUrl})` }} />
          )}
          <div className="absolute inset-0 bg-black/75" />
          <div className="relative z-10 flex flex-col items-center gap-5 text-center px-8">
            <div className="flex flex-col items-center gap-1">
              <p className="text-white/40 text-[10px] uppercase tracking-[0.25em] font-medium">Você está assistindo</p>
              <p className="text-white font-bold text-lg md:text-xl leading-snug">{titulo}</p>
              {temporada && numeroEp && (
                <p className="text-white/60 text-sm mt-0.5">
                  T{temporada} EP{numeroEp}{nomeEpisodio ? ` · ${nomeEpisodio}` : ""}
                </p>
              )}
            </div>
            <BouncingDots />
          </div>
        </div>
      )}

      {/* Native buffering */}
      {status === "loading" && streamTipo === "native" && !autoPlayBlocked && (
        <div className="absolute inset-0 z-[99999] flex items-center justify-center">
          <BouncingDots size="sm" />
        </div>
      )}

      {/* +30s skip (native mode) */}
      {streamTipo === "native" && status === "playing" && (
        <button
          onClick={() => {
            const video = videoRef.current;
            if (video) video.currentTime = Math.min(video.currentTime + 30, video.duration - 1);
          }}
          className="absolute bottom-24 right-4 z-[9999] flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/60 border border-white/20 text-white text-xs font-bold hover:bg-white/20 transition-all backdrop-blur"
        >
          +30s
        </button>
      )}

      {/* Autoplay blocked (native) */}
      {autoPlayBlocked && streamTipo === "native" && (
        <div
          className="absolute inset-0 z-[99999] flex items-center justify-center cursor-pointer"
          onClick={() => { videoRef.current?.play().then(() => setAutoPlayBlocked(false)).catch(() => {}); }}
        >
          <div className="w-20 h-20 rounded-full bg-black/50 backdrop-blur-sm border border-white/20 flex items-center justify-center hover:bg-white/10 transition-colors">
            <Play size={38} fill="white" strokeWidth={0} className="ml-1" />
          </div>
        </div>
      )}

      {/* Retry */}
      {showRetry && status !== "error" && status !== "extracting" && (
        <div className="absolute inset-0 z-[99999] flex items-center justify-center bg-black/50">
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

      {/* Error */}
      {status === "error" && (
        <div className="absolute inset-0 z-[99999] flex flex-col items-center justify-center bg-black/75 gap-5">
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

      {/* No fontes */}
      {status === "idle" && allFontes.length === 0 && (
        <div className="absolute inset-0 z-[99999] flex items-center justify-center">
          <p className="text-white/30 text-sm">Nenhuma fonte disponível</p>
        </div>
      )}

      {/* Auto-skip next episode */}
      {nextEpCountdown !== null && nextUrl && (
        <div className="absolute bottom-24 right-6 z-[9999] flex items-center gap-3 bg-black/80 backdrop-blur border border-white/10 rounded-xl px-4 py-3 shadow-xl">
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
  );
}
