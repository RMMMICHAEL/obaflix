"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Play, Pause, AlertCircle, RotateCcw, Cast, Flag, Volume2, VolumeX, Maximize, Minimize2, PictureInPicture2, Settings2, Check } from "lucide-react";
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
import { classificarEtapa, logEtapa } from "@/lib/playerDiag";

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

interface Fonte {
  label: string;
  embedUrl: string;
  tokenized: boolean;
  /** Servidor interno do mesmo player (ex.: "Automático", "WatchPlayer"). */
  servidor?: string;
  /** Provedor reconhecido por detectProvider; usado só no diagnóstico. */
  provider?: string;
  /** Fonte sem extrator conhecido — só serve como iframe de última linha. */
  semExtrator?: boolean;
}

/** Uma fonte do Playerflix, como /api/player/playerflix-sources devolve. */
interface PlayerflixSource {
  id: string;
  name: string;
  provider: string;
  url: string;
  hasExtractor: boolean;
}
interface SubtitleTrack { file: string; label?: string; kind?: string; default?: boolean; referer?: string; }
interface QualityLevel { label?: string; height?: number; width?: number; bitrate?: number; }
interface AudioTrack { name?: string; label?: string; language?: string; }
interface CaptionTrack { id?: string | number; label?: string; language?: string; }

type CaptionColor = "softWhite" | "warmYellow" | "cyan";
type CaptionSize = "small" | "standard" | "large" | "extraLarge";
type CaptionEdgeStyle = "uniform" | "dropshadow" | "none";

interface CaptionPreferences {
  color: CaptionColor;
  size: CaptionSize;
  backgroundOpacity: number;
  edgeStyle: CaptionEdgeStyle;
}

const CAPTION_PREFERENCES_KEY = "obaflix.caption-preferences.v1";
const CAPTION_COLORS: Record<CaptionColor, { label: string; value: string }> = {
  softWhite: { label: "Branco", value: "#f5f4f2" },
  warmYellow: { label: "Amarelo", value: "#ffd866" },
  cyan: { label: "Ciano", value: "#7ee7f2" },
};
const CAPTION_SIZES: Record<CaptionSize, { label: string; scale: number }> = {
  small: { label: "Pequena", scale: 0.84 },
  standard: { label: "Padrão", scale: 1 },
  large: { label: "Grande", scale: 1.2 },
  extraLarge: { label: "Extra", scale: 1.42 },
};
const DEFAULT_CAPTION_PREFERENCES: CaptionPreferences = {
  color: "softWhite",
  size: "standard",
  backgroundOpacity: 68,
  edgeStyle: "uniform",
};

function readCaptionPreferences(value: string | null): CaptionPreferences {
  if (!value) return DEFAULT_CAPTION_PREFERENCES;
  try {
    const parsed = JSON.parse(value) as Partial<CaptionPreferences>;
    const color = parsed.color && parsed.color in CAPTION_COLORS
      ? parsed.color
      : DEFAULT_CAPTION_PREFERENCES.color;
    const size = parsed.size && parsed.size in CAPTION_SIZES
      ? parsed.size
      : DEFAULT_CAPTION_PREFERENCES.size;
    const backgroundOpacity = typeof parsed.backgroundOpacity === "number"
      ? Math.min(100, Math.max(0, Math.round(parsed.backgroundOpacity)))
      : DEFAULT_CAPTION_PREFERENCES.backgroundOpacity;
    const edgeStyle = parsed.edgeStyle === "uniform" || parsed.edgeStyle === "dropshadow" || parsed.edgeStyle === "none"
      ? parsed.edgeStyle
      : DEFAULT_CAPTION_PREFERENCES.edgeStyle;
    return { color, size, backgroundOpacity, edgeStyle };
  } catch {
    return DEFAULT_CAPTION_PREFERENCES;
  }
}

function captionFontSize(preferences: CaptionPreferences) {
  const viewportHeight = typeof window === "undefined" ? 720 : window.innerHeight;
  const base = Math.min(34, Math.max(20, Math.round(viewportHeight * 0.052)));
  return Math.round(base * CAPTION_SIZES[preferences.size].scale);
}

function jwCaptionStyles(preferences: CaptionPreferences) {
  return {
    backgroundColor: "#101014",
    backgroundOpacity: preferences.backgroundOpacity,
    color: CAPTION_COLORS[preferences.color].value,
    edgeColor: "#09090d",
    edgeStyle: preferences.edgeStyle,
    fontFamily: "Arial, Helvetica, sans-serif",
    fontOpacity: 100,
    fontSize: captionFontSize(preferences),
    windowColor: "#101014",
    windowOpacity: 0,
  };
}

function captionTextShadow(edgeStyle: CaptionEdgeStyle) {
  if (edgeStyle === "none") return "none";
  if (edgeStyle === "dropshadow") return "0 0.12em 0.18em rgba(9, 9, 13, 0.98)";
  return [
    "-0.055em -0.055em 0 #09090d",
    "0.055em -0.055em 0 #09090d",
    "-0.055em 0.055em 0 #09090d",
    "0.055em 0.055em 0 #09090d",
    "0 0.1em 0.16em rgba(9, 9, 13, 0.92)",
  ].join(",");
}

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
    if (pathname.includes("voltz.php")) return true;
    if (hostname.includes("lulu")) return true;
    if (hostname.includes("hide")) return true;
    if (hostname.includes("wish")) return true;
    if (hostname.includes("llanfair") || pathname.includes("/rola/")) return true;
    if (hostname.includes("bolt")) return true;
    if (hostname.includes("bigshare") || hostname.includes("big")) return true;
    if (hostname.includes("watchplay")) return true;
    if (hostname === "superflixapi.pro" || hostname.endsWith(".superflixapi.pro")) return true;
    if (hostname === "redecanais.capital" || hostname.endsWith(".redecanais.capital")) return true;
    return false;
  } catch {
    return false;
  }
}

function isSuperflixUrl(url: string) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "superflixapi.pro" || hostname.endsWith(".superflixapi.pro");
  } catch {
    return false;
  }
}

function isPlayerflixAjaxUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "playerflix.ink" && parsed.pathname === "/inc/Ajax.php";
  } catch {
    return false;
  }
}

function friendlyPlayerError(error: unknown, label: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const detail = raw.trim();
  if (!detail || detail === "null" || /erro desconhecido/i.test(detail)) {
    return `${label}: o servidor não informou a causa da falha.`;
  }
  if (/handshake failed|sslhandshake/i.test(detail)) {
    return `${label}: o servidor recusou a conexão segura. Tente novamente ou escolha outro servidor.`;
  }
  if (/stream n[aã]o encontrado|servidor compatível não encontrado/i.test(detail)) {
    return `${label}: nenhuma mídia disponível foi encontrada para este título.`;
  }
  return detail.startsWith(`${label}:`) ? detail : `${label}: ${detail}`;
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

// Separa a URL do Voltz (contém "voltz.php") das demais fontes de urlDub/urlLeg,
// para que possa ser posicionada como Player 1 independentemente da ordem do warez2.
function splitVoltz(urls: string | null): { voltz: string | null; rest: string | null } {
  if (!urls) return { voltz: null, rest: null };
  const parts = urls.split(",").map((u) => u.trim()).filter(Boolean);
  const idx = parts.findIndex((u) => u.includes("voltz.php"));
  if (idx === -1) return { voltz: null, rest: urls };
  const voltz = parts[idx];
  const rest = parts.filter((_, i) => i !== idx).join(",") || null;
  return { voltz, rest };
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
  if (level === "warn") console.warn(msg);
  else console.log(msg);
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
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
  const mp4CooldownUntilRef = useRef(0); // timestamp (ms) até quando re-extração MP4 está em cooldown após falha
  const streamExpiresAtRef = useRef<number | null>(null); // epoch (ms) declarado pelo token da cadeia (SuperFlix); null = desconhecido
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // renovação agendada antes do token expirar
  const serverSwitchCountRef = useRef(0); // total de trocas automáticas de servidor nesta sessão
  const userAudioTrackRef = useRef<number | null>(null); // null = sem escolha manual; senão, índice escolhido pelo usuário — mantido durante todo o episódio (até remontagem por key={episodio.id})
  const userQualityRef = useRef<number | null>(null); // null = automática; índice do JW quando o usuário fixa uma qualidade
  const userCaptionRef = useRef<number | null>(null); // null = seleção inicial; 0 = desligada; >0 = faixa escolhida
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
  // Identidade da fonte ativa por URL, imune ao crescimento da lista de fontes.
  const fonteSelecionadaRef = useRef<string | null>(null);
  const allFontesRef = useRef<Fonte[]>([]);
  const nextUrlRef = useRef(nextUrl);
  const nextEpCountdownActiveRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRetryDoneRef = useRef(false);
  const extractRef = useRef<(url: string) => void>(() => {});
  const castContextRef = useRef<any>(null);
  // Guarda desmontagem: impede setState/callbacks após unmount e durante navegação auto-skip
  const unmountedRef = useRef(false);
  // UI controls
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetControlsTimerRef = useRef<() => void>(() => {});

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
  const desktopBridge = typeof window !== "undefined" ? (window as any).obaflixDesktop : null;
  const isDesktop = !!desktopBridge;
  const isAndroid = desktopBridge?.platform === "android" ||
    (typeof window !== "undefined" && (window as any).__OBAFLIX_ANDROID__ === true);

  // Servidores alternativos que o Playerflix conhece para este conteúdo. A lista é
  // aditiva: enquanto estiver vazia — carregando, falhou ou o conteúdo não tem
  // alternativas — o Player 1 se comporta exatamente como antes.
  const [playerflixSources, setPlayerflixSources] = useState<PlayerflixSource[]>([]);
  // Servidores que já falharam de forma fatal, por embedUrl, com o motivo.
  const [servidoresFalhos, setServidoresFalhos] = useState<Record<string, string>>({});

  // ── Download ────────────────────────────────────────────────────────────────
  const [showDownload, setShowDownload] = useState(false);
  const [downloadProgresso, setDownloadProgresso] = useState<
    { pct: number; atual: number; total: number; bytes: number } | null
  >(null);
  const [downloadResultado, setDownloadResultado] = useState<
    { caminho: string; erro?: string } | null
  >(null);

  const allFontes: Fonte[] = [];

  // Players 1, 2 e 5 montam a URL a partir do tmdbId. Parte do catálogo grava
  // "0" nesse campo (títulos sem correspondência no TMDB), e "0" é uma string
  // truthy — passava na checagem e gerava embeds como
  // `Ajax.php?id=0&type=tv`, que falham sempre. Só um inteiro positivo serve.
  const tmdbValido = tmdbId && /^[1-9][0-9]*$/.test(String(tmdbId).trim())
    ? String(tmdbId).trim()
    : null;

  const { voltz: voltzUrl, rest: urlDubRest } = splitVoltz(urlDub);

  const parsedFontes = [
    ...parseFontes(urlDubRest, "[Dub]", isDesktop),
    ...parseFontes(urlLeg, "[Leg]", isDesktop),
  ];

  const isProvider = (fonte: Fonte, provider: string) => {
    try {
      return new URL(fonte.embedUrl).hostname.toLowerCase().includes(provider);
    } catch {
      return fonte.embedUrl.toLowerCase().includes(provider);
    }
  };

  const hideFonte = parsedFontes.find((fonte) =>
    isProvider(fonte, "hide"),
  );

  const wishFonte = parsedFontes.find((fonte) =>
    isProvider(fonte, "wish"),
  );

  const redeCanaisFonte = parsedFontes.find((fonte) =>
    isProvider(fonte, "redecanais.capital"),
  );

  // Player 1: PlayerFlix.
  //
  // A entrada primária continua sendo a URL Ajax: o extrator escolhe o servidor
  // internamente, como sempre fez. As fontes explícitas do Playerflix entram logo
  // depois, com o mesmo rótulo "Player 1" e um `servidor` próprio — servem para o
  // failover automático (switchFonte já percorre a lista em ordem) e para a troca
  // manual. Se a lista vier vazia, sobra só a primária e nada muda.
  if (tmdbValido) {
    const ajaxUrl = conteudoTipo === "serie" && temporada && numeroEp
      ? `https://playerflix.ink/inc/Ajax.php?id=${tmdbValido}&type=tv&season=${temporada}&episode=${numeroEp}`
      : conteudoTipo === "filme"
        ? `https://playerflix.ink/inc/Ajax.php?id=${tmdbValido}&type=movie`
        : null;

    if (ajaxUrl) {
      allFontes.push({
        label: "Player 1",
        embedUrl: ajaxUrl,
        tokenized: false,
        servidor: "Automático",
      });

      for (const fonteExplicita of playerflixSources) {
        // A fonte sem extrator só faz sentido onde o iframe do provedor funciona.
        if (!fonteExplicita.hasExtractor && !isDesktop) continue;
        allFontes.push({
          label: "Player 1",
          embedUrl: fonteExplicita.url,
          tokenized: false,
          servidor: fonteExplicita.name,
          provider: fonteExplicita.provider,
          semExtrator: !fonteExplicita.hasExtractor,
        });
      }
    }
  }

  // Player 2: SuperFlix — Electron apenas, nunca Android.
  //
  // O provedor bloqueia o aplicativo pelo nome do pacote: a WebView do Android
  // envia "X-Requested-With: com.obaflix" e o superflixapi.pro responde uma
  // pagina de acesso negado em vez do embed (Chrome e Firefox recebem o desafio
  // normal, entao o bloqueio e nominal, nao uma politica geral contra apps).
  // No Electron nao ha esse header e o player funciona, por isso a fonte
  // continua disponivel la. Oferecer no Android so entrega uma tela de erro.
  if (
    isDesktop &&
    !isAndroid &&
    tmdbValido &&
    (conteudoTipo === "filme" ||
      (conteudoTipo === "serie" && temporada && numeroEp))
  ) {
    const superflixUrl =
      conteudoTipo === "filme"
        ? `https://superflixapi.pro/filme/${encodeURIComponent(tmdbValido)}`
        : `https://superflixapi.pro/serie/${encodeURIComponent(tmdbValido)}/${temporada}/${numeroEp}`;

    allFontes.push({
      label: "Player 2",
      embedUrl: superflixUrl,
      tokenized: false,
    });
  }

  // Player 3: Voltz — somente Electron/Android.
  // No site, o MP4 direto pode falhar por CORS ou exigência de Referer.
  if (isDesktop && voltzUrl) {
    allFontes.push({
      label: "Player 3",
      embedUrl: voltzUrl,
      tokenized: false,
    });
  }

  // Player 4: Hide
  if (hideFonte) {
    allFontes.push({
      ...hideFonte,
      label: "Player 4",
    });
  }

  // Player 5: WatchPlay. Os extratores (Kotlin, Electron e rota web) já tratavam
  // /tvshow desde sempre; era só aqui que a fonte não chegava a ser oferecida.
  if (isDesktop && tmdbValido) {
    if (conteudoTipo === "filme") {
      allFontes.push({
        label: "Player 5",
        embedUrl: `https://v1.watchplay.shop/movie/${encodeURIComponent(tmdbValido)}`,
        tokenized: false,
      });
    } else if (conteudoTipo === "serie" && temporada && numeroEp) {
      allFontes.push({
        label: "Player 5",
        embedUrl: `https://v1.watchplay.shop/tvshow/${encodeURIComponent(tmdbValido)}/${temporada}/${numeroEp}`,
        tokenized: false,
      });
    }
  }

  // Player 6: Wish
  if (wishFonte) {
    allFontes.push({
      ...wishFonte,
      label: "Player 6",
    });
  }

  // Player 7: RedeCanais — somente Android. A URL do conteúdo precisa estar
  // cadastrada em urlDub/urlLeg; o app não escolhe resultados por título para
  // evitar reproduzir um filme ou episódio diferente por engano.
  if (isAndroid && redeCanaisFonte) {
    allFontes.push({
      ...redeCanaisFonte,
      label: "Player 7",
    });
  }

  const [fonteIdx, setFonteIdx] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamTipo, setStreamTipo] = useState<StreamTipo>("hls");
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  // Unified playback state (JW + native)
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1); // 0–1
  const [muted, setMuted] = useState(false);
  // Controls UI
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([]);
  const [currentQuality, setCurrentQuality] = useState(0);
  const [visualQualityLabel, setVisualQualityLabel] = useState("");
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [currentAudioTrack, setCurrentAudioTrack] = useState(0);
  const [captionTracks, setCaptionTracks] = useState<CaptionTrack[]>([]);
  const [currentCaption, setCurrentCaption] = useState(0);
  const [showPlaybackSettings, setShowPlaybackSettings] = useState(false);
  const [showCaptionAppearance, setShowCaptionAppearance] = useState(false);
  const [captionPreferences, setCaptionPreferences] = useState<CaptionPreferences>(DEFAULT_CAPTION_PREFERENCES);
  const [captionPreferencesReady, setCaptionPreferencesReady] = useState(false);
  const captionPreferencesRef = useRef(DEFAULT_CAPTION_PREFERENCES);
  const [autoPlayBlocked, setAutoPlayBlocked] = useState(false);
  const [nextEpCountdown, setNextEpCountdown] = useState<number | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  const [recovering, setRecovering] = useState(false); // mini spinner durante re-extração MP4 silenciosa
  // chromecast
  const [castAvailable, setCastAvailable] = useState(false);
  const [isCasting, setIsCasting] = useState(false);
  // sources dropdown
  const [showSources, setShowSources] = useState(false);

  const fonte = allFontes[fonteIdx];

  // Rótulo usado no diagnóstico: distingue "Player 1 · WatchPlayer" de
  // "Player 1 · VIP Player", em vez de só "Player 1 falhou".
  const rotuloDiag = fonte?.servidor ? `${fonte.label} · ${fonte.servidor}` : fonte?.label ?? "?";

  allFontesRef.current = allFontes;

  // As alternativas do Player 1 entram no meio da lista alguns segundos depois do
  // primeiro render, deslocando todos os índices seguintes. Sem realinhar, quem já
  // tivesse avançado para o Player 2 seria jogado numa fonte do Player 1 no meio da
  // reprodução. A identidade da fonte é a URL; o índice é só posição.
  useEffect(() => {
    const alvo = fonteSelecionadaRef.current;
    if (!alvo) return;
    if (allFontes[fonteIdx]?.embedUrl === alvo) return;
    const novoIdx = allFontes.findIndex((f) => f.embedUrl === alvo);
    if (novoIdx >= 0 && novoIdx !== fonteIdx) {
      console.log(`[diag/server] lista cresceu; fonte realinhada idx=${fonteIdx}→${novoIdx}`);
      setFonteIdx(novoIdx);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFontes.length]);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(CAPTION_PREFERENCES_KEY);
    } catch {
      // O player continua com o padrão acessível quando o armazenamento é bloqueado.
    }
    const saved = readCaptionPreferences(stored);
    captionPreferencesRef.current = saved;
    setCaptionPreferences(saved);
    setCaptionPreferencesReady(true);
  }, []);

  useEffect(() => {
    captionPreferencesRef.current = captionPreferences;
    if (captionPreferencesReady) {
      try {
        window.localStorage.setItem(CAPTION_PREFERENCES_KEY, JSON.stringify(captionPreferences));
      } catch {
        // Preferências continuam válidas durante a sessão quando o storage é bloqueado.
      }
    }

    const applyStyles = () => {
      const player = jwRef.current;
      if (player?.setCaptions) player.setCaptions(jwCaptionStyles(captionPreferences));
    };
    applyStyles();
    window.addEventListener("resize", applyStyles);
    return () => window.removeEventListener("resize", applyStyles);
  }, [captionPreferences, captionPreferencesReady]);

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

  // ── Controls visibility + fullscreen ────────────────────────────────────────
  const resetControlsTimer = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setControlsVisible(false), 3500);
  }, []);
  resetControlsTimerRef.current = resetControlsTimer;

  const toggleFullscreen = useCallback(() => {
    // Mantém o fullscreen durante a troca de episódio.
    // O container do CustomPlayer é desmontado pelo router.push(nextUrl), mas o
    // documentElement permanece montado durante a navegação do Next.js.
    const el = document.documentElement;
    const bridge = (window as { obaflixDesktop?: { toggleFullscreen?: () => void } }).obaflixDesktop;

    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch((error) => {
        console.error("[player] exitFullscreen falhou:", error?.name, error?.message);
        bridge?.toggleFullscreen?.();
      });
      return;
    }

    // No Electron, uma versao do app que nega a permissao "fullscreen" faz esta
    // promise ficar PENDENTE para sempre: nao resolve nem rejeita, entao o botao
    // parecia morto e nem o catch rodava. Por isso o fallback e por tempo, e nao
    // so por erro — assim as instalacoes antigas do .exe tambem voltam a ter tela
    // cheia, usando a janela nativa via bridge.
    let resolvido = false;
    el.requestFullscreen?.().then(
      () => { resolvido = true; },
      (error) => {
        resolvido = true;
        console.error("[player] requestFullscreen falhou:", error?.name, error?.message);
        bridge?.toggleFullscreen?.();
      },
    );

    if (bridge?.toggleFullscreen) {
      window.setTimeout(() => {
        if (resolvido || document.fullscreenElement) return;
        console.error("[player] requestFullscreen ficou pendente — usando a janela nativa do Electron");
        bridge.toggleFullscreen?.();
      }, 700);
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // ── Picture-in-picture ─────────────────────────────────────────────────────
  // Dois caminhos de reproducao tem um <video> de verdade no DOM: o nativo, que e
  // o nosso videoRef, e o do JW Player, que cria o proprio elemento dentro do
  // container. O caminho "iframe" e de outra origem — nao ha elemento acessivel,
  // entao o botao nem aparece em vez de aparecer quebrado.
  const getVideoElement = useCallback((): HTMLVideoElement | null => {
    if (streamTipo === "native") return videoRef.current;
    if (streamTipo === "hls" || streamTipo === "mp4") {
      return document.querySelector<HTMLVideoElement>("#jw-player-container video");
    }
    return null;
  }, [streamTipo]);

  const pipDisponivel =
    typeof document !== "undefined" &&
    document.pictureInPictureEnabled &&
    streamTipo !== "iframe";

  const togglePiP = useCallback(async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      const video = getVideoElement();
      if (!video) {
        console.error("[player] PiP indisponivel: nenhum <video> acessivel para", streamTipo);
        return;
      }
      // O JW Player marca o proprio elemento com disablePictureInPicture em
      // algumas versoes; sem limpar isso o navegador recusa o pedido.
      video.disablePictureInPicture = false;
      await video.requestPictureInPicture();
    } catch (error) {
      const e = error as { name?: string; message?: string };
      console.error("[player] PiP falhou:", e?.name, e?.message);
    }
  }, [getVideoElement, streamTipo]);

  // O usuario pode sair do PiP pela janelinha do proprio sistema, entao o estado
  // vem dos eventos do documento e nao do clique no botao.
  useEffect(() => {
    const entrou = () => setIsPiP(true);
    const saiu = () => setIsPiP(false);
    document.addEventListener("enterpictureinpicture", entrou);
    document.addEventListener("leavepictureinpicture", saiu);
    return () => {
      document.removeEventListener("enterpictureinpicture", entrou);
      document.removeEventListener("leavepictureinpicture", saiu);
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (streamTipo === "iframe") return;
      if (e.code === "Space" || e.code === "KeyK") {
        e.preventDefault();
        if (jwRef.current) {
          const state = jwRef.current.getState?.();
          if (state === "playing") jwRef.current.pause();
          else jwRef.current.play();
        } else if (videoRef.current) {
          if (videoRef.current.paused) videoRef.current.play().catch(() => {});
          else videoRef.current.pause();
        }
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const pos = progressoRef.current;
        if (jwRef.current) jwRef.current.seek(pos + 10);
        else if (videoRef.current) videoRef.current.currentTime = Math.min(pos + 10, (videoRef.current.duration || Infinity) - 1);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        const newPos = Math.max(0, progressoRef.current - 10);
        if (jwRef.current) jwRef.current.seek(newPos);
        else if (videoRef.current) videoRef.current.currentTime = newPos;
      } else if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.code === "KeyI") {
        e.preventDefault();
        togglePiP();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [streamTipo, toggleFullscreen, togglePiP]);

  // ── switchFonte ──────────────────────────────────────────────────────────────
  const switchFonte = useCallback((idx: number) => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    if (reExtractDebounceRef.current) { clearTimeout(reExtractDebounceRef.current); reExtractDebounceRef.current = null; }
    if (expiryTimerRef.current) { clearTimeout(expiryTimerRef.current); expiryTimerRef.current = null; }
    if (jwRef.current) { try { jwRef.current.remove(); } catch {} jwRef.current = null; }
    streamExpiresAtRef.current = null;
    // Guarda a fonte por URL, não por índice: a lista cresce quando as
    // alternativas do Player 1 chegam, e aí o índice passa a apontar para outra.
    fonteSelecionadaRef.current = allFontesRef.current[idx]?.embedUrl ?? null;
    setFonteIdx(idx);
    setStatus("idle");
    setStreamUrl(null);
    setSubtitleTracks([]);
    setError("");
    setShowRetry(false);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setQualityLevels([]);
    setCurrentQuality(0);
    setVisualQualityLabel("");
    setAudioTracks([]);
    setCurrentAudioTrack(0);
    setCaptionTracks([]);
    setCurrentCaption(0);
    setShowPlaybackSettings(false);
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
    mp4CooldownUntilRef.current = 0;
    serverSwitchCountRef.current += 1;
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

      // No Android o iframe fica visível apenas durante a validação Cloudflare. Em
      // paralelo, o bridge aguarda cf_clearance e então troca a página do provedor
      // pela mídia extraída localmente. Isso evita terminar no 404 do iframe.
      if (isAndroid && isSuperflixUrl(embedUrl)) {
        setStreamTipo("iframe");
        setStreamUrl(embedUrl);
        // Mantém o carregamento padrão do app por cima até a página do provedor
        // aparecer, em vez de expor o iframe cru com o carregamento dele. O
        // iframe já está no DOM, então o desafio do Cloudflare roda por baixo.
        setStatus("extracting");
        if (!desktop) return;
        const data: { stream?: string; tipo?: string; referer?: string; subtitles?: SubtitleTrack[]; expiresAt?: number | null; error?: string } =
          await desktop.extractStream(embedUrl);
        if (data.error || !data.stream) throw new Error(data.error || "Stream não encontrado");
        streamExpiresAtRef.current = data.expiresAt ?? null;
        tipo = data.tipo ?? "hls";
        playerUrl = buildElectronProxyUrl(data.stream, data.referer);
        streamRefererRef.current = data.referer ?? null;
        directStreamRef.current = data.stream;
        setSubtitleTracks((data.subtitles ?? []).map((track) => ({
          ...track,
          file: buildElectronProxyUrl(track.file, track.referer || data.referer),
          kind: "captions",
        })));
      } else if (embedUrl.startsWith("https://vidsrc-embed.ru/embed/")) {
        // Vidsrc já é um player embed completo. Carrega direto no iframe para não
      // gastar uma chamada ao Vercel Compute tentando extrair uma mídia que deve
      // continuar dentro do player do próprio provedor.
        setStreamTipo("iframe");
        setStreamUrl(embedUrl);
        setStatus("playing");
        return;
      } else if (desktop && (supportsNativeDesktopExtraction(embedUrl) || (isAndroid && isPlayerflixAjaxUrl(embedUrl)))) {
        // Electron/Android: extração nativa via bridge (IP residencial do usuário)
        const data: { stream?: string; tipo?: string; referer?: string; subtitles?: SubtitleTrack[]; expiresAt?: number | null; error?: string } =
          await desktop.extractStream(embedUrl);
        if (data.error || !data.stream) throw new Error(data.error || "Stream não encontrado");
        streamExpiresAtRef.current = data.expiresAt ?? null;
        tipo = data.tipo ?? "hls";
        // No Electron, usamos a URL direta (DevTools do Electron é local, não exposto)
        playerUrl = tipo === "iframe" ? data.stream! : buildElectronProxyUrl(data.stream!, data.referer);
        streamRefererRef.current = data.referer ?? null;
        directStreamRef.current = data.stream!;
        setSubtitleTracks((data.subtitles ?? []).map((track) => ({
          ...track,
          file: buildElectronProxyUrl(track.file, track.referer || data.referer),
          kind: "captions",
        })));
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
          // A rota responde 200 mesmo quando desiste da extração, então este
          // caminho é invisível no DevTools: o pulo para a próxima fonte nasce
          // do throw abaixo, não de um erro de rede. O motivo vem do servidor
          // ("timeout", "sem_fonte_extraivel", "erro") e é registrado aqui para
          // aparecer no console do navegador e no logcat do Android.
          const motivo = data.motivo ?? "desconhecido";
          // Falha de extração é fatal para esta fonte: marca para o menu mostrar
        // "indisponível" e para não insistir nela na troca manual.
        if (fonte?.embedUrl) {
          const url = fonte.embedUrl;
          const razao = motivo === "timeout" ? "sem resposta" : "extração falhou";
          setServidoresFalhos((atual) => (atual[url] ? atual : { ...atual, [url]: razao }));
        }
        logEtapa(rotuloDiag, motivo === "timeout" ? "TIMEOUT" : "EXTRACT_FAILED", {
            url: embedUrl,
            mensagem: motivo,
          });
          console.warn(
            `[player] extração desistiu: motivo=${motivo} fonte=${fonte?.label ?? "?"} ` +
            `— servindo iframe do provedor`,
          );
          // esses players nunca servem iframe válido — iframe fallback = extração falhou
          if (embedUrl.includes("playerflix.ink") || embedUrl.includes("webcinevs2.com")) {
            throw new Error(`Stream não encontrado (${motivo})`);
          }
          playerUrl = data.stream!;
        } else if (tipo === "mp4_direct") {
          // CDN bloqueia IPs de datacenter — serve URL direta ao browser (IP residencial passa)
          if (!data.stream) throw new Error("Stream não encontrado");
          playerUrl = data.stream;
          tipo = "mp4";
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
        setError(friendlyPlayerError(e, fonte?.label ?? "Player"));
        setStatus("error");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonteIdx, allFontes.length, switchFonte, isAndroid]);

  extractRef.current = extract;

  useEffect(() => {
    if (!fonte?.embedUrl) return;
    extract(fonte.embedUrl);
  }, [fonte?.embedUrl, extract]);

  // ── Download da mídia atual ─────────────────────────────────────────────────
  // Só no app desktop: o navegador não consegue mandar o Referer que os CDNs
  // exigem, e os segmentos vêm de dezenas de hosts que barrariam por CORS.
  const podeBaixar = !!desktopBridge?.downloadMedia &&
    !!directStreamRef.current &&
    (streamTipo === "hls" || streamTipo === "mp4");

  useEffect(() => {
    desktopBridge?.onDownloadProgress?.((p: { pct: number; atual: number; total: number; bytes: number; etapa: string }) => {
      if (p.etapa === "concluido") return;
      setDownloadProgresso({ pct: p.pct ?? 0, atual: p.atual ?? 0, total: p.total ?? 0, bytes: p.bytes ?? 0 });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const iniciarDownload = useCallback(async (modo: "completo" | "trecho", duracaoSeg?: number) => {
    const stream = directStreamRef.current;
    if (!stream || !desktopBridge?.downloadMedia) return;

    setShowDownload(false);
    setDownloadResultado(null);
    setDownloadProgresso({ pct: 0, atual: 0, total: 0, bytes: 0 });

    const nome = [titulo, temporada && numeroEp ? `T${temporada}E${numeroEp}` : null]
      .filter(Boolean).join(" ");
    // O trecho começa onde o usuário está assistindo.
    const inicio = modo === "trecho" ? Math.max(0, progressoRef.current) : undefined;

    try {
      const r = await desktopBridge.downloadMedia({
        stream,
        referer: streamRefererRef.current,
        tipo: streamTipo === "mp4" ? "mp4" : "hls",
        titulo: nome,
        modo,
        inicioSeg: inicio,
        fimSeg: modo === "trecho" ? (inicio ?? 0) + (duracaoSeg ?? 300) : undefined,
      });
      setDownloadProgresso(null);
      if (r?.ok) setDownloadResultado({ caminho: r.caminho });
      else if (!r?.cancelado) setDownloadResultado({ caminho: "", erro: r?.error || "Falha no download" });
    } catch (e: any) {
      setDownloadProgresso(null);
      setDownloadResultado({ caminho: "", erro: e?.message || "Falha no download" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamTipo, titulo, temporada, numeroEp]);

  // Registra qual servidor interno está sendo tentado. Sem isso o log só diz
  // "Player 1 falhou", sem distinguir qual das fontes do Playerflix falhou.
  useEffect(() => {
    if (!fonte) return;
    const irmas = allFontes.filter((f) => f.label === fonte.label);
    const posicao = irmas.findIndex((f) => f.embedUrl === fonte.embedUrl) + 1;
    console.log(
      `[diag/server] player=${fonte.label} server=${fonte.servidor ?? "-"} ` +
      `provider=${fonte.provider ?? "auto"} attempt=${posicao}/${irmas.length}`,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonte?.embedUrl]);

  // Descobre os servidores alternativos do Player 1. É estritamente aditivo: erro,
  // lista vazia ou resposta lenta deixam o Player 1 como está hoje. Roda em
  // paralelo à extração da fonte primária, sem atrasá-la.
  useEffect(() => {
    setPlayerflixSources([]);
    setServidoresFalhos({});
    if (!tmdbValido) return;
    if (conteudoTipo === "serie" && (!temporada || !numeroEp)) return;

    const ctrl = new AbortController();
    const params = new URLSearchParams({ tmdbId: String(tmdbValido) });
    if (conteudoTipo === "serie") {
      params.set("type", "tv");
      params.set("season", String(temporada));
      params.set("episode", String(numeroEp));
    } else {
      params.set("type", "movie");
    }

    fetch(`/api/player/playerflix-sources?${params.toString()}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const lista: PlayerflixSource[] = Array.isArray(data?.sources) ? data.sources : [];
        if (!lista.length) return;
        setPlayerflixSources(lista);
        console.log(
          `[diag/server] player=Player 1 alternativas=${lista.length} ` +
          lista.map((s) => `${s.name}(${s.provider})`).join(" "),
        );
      })
      .catch(() => { /* aditivo: sem alternativas, o Player 1 segue como hoje */ });

    return () => ctrl.abort();
  }, [tmdbValido, conteudoTipo, temporada, numeroEp]);

  // Rede de segurança do carregamento do SuperFlix: se o load do iframe não
  // chegar (bloqueio de rede, desafio travado), a tela não pode ficar presa no
  // spinner esperando um evento que não vem.
  //
  // O limite é curto de propósito: o carregamento cobre o iframe e, como a
  // escolha do servidor é manual, cada segundo a mais é um segundo em que o
  // toque do usuário não passa.
  useEffect(() => {
    if (status !== "extracting" || streamTipo !== "iframe") return;
    if (!streamUrl || !isSuperflixUrl(streamUrl)) return;
    const timer = setTimeout(() => setStatus("playing"), 4000);
    return () => clearTimeout(timer);
  }, [status, streamTipo, streamUrl]);

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
    const tracks = subtitleTracks.map((track, index) => ({
      file: track.file,
      label: track.label || "Português",
      kind: "captions",
      default: track.default ?? index === 0,
    }));

    loadJW(() => {
      // Componente pode ter desmontado enquanto o script JW carregava
      if (unmountedRef.current) return;
      const jw = (window as any).jwplayer;
      if (!jw) return;
      jw.key = JW_KEY;

      const player = jw("jw-player-container").setup({
        sources,
        tracks,
        image: thumbUrl || undefined,
        controls: false,
        sharing: false,
        autostart: true,
        displaytitle: false,
        displaydescription: false,
        renderCaptionsNatively: false,
        captions: jwCaptionStyles(captionPreferencesRef.current),
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
      player.on("firstFrame", () => {
        initialLoadRef.current = false;
        // Único ponto que prova reprodução de verdade: o primeiro frame só
        // aparece depois do init segment e dos primeiros segmentos de mídia.
        // "extract respondeu 200" não significa nada aqui.
        logEtapa(rotuloDiag, "OK_PLAYBACK", {
          url: directStreamRef.current ?? undefined,
          ms: lastLoadAtRef.current > 0 ? Date.now() - lastLoadAtRef.current : undefined,
        });
      });

      player.on("play", () => {
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        setShowRetry(false);
        setStatus("playing");
        setPlaying(true);
        initialLoadRef.current = false; // fallback: garante transição caso firstFrame não dispare
        reExtractCountRef.current = 0;
        resetControlsTimerRef.current();
      });
      player.on("pause", () => {
        setPlaying(false);
        setControlsVisible(true);
        if (controlsTimerRef.current) { clearTimeout(controlsTimerRef.current); controlsTimerRef.current = null; }
        saveProgressRef.current();
      });
      player.on("complete", () => { saveProgressRef.current(); });

      player.on("time", ({ position, duration }: any) => {
        if (unmountedRef.current) return;
        progressoRef.current = Math.floor(position);
        if (isFinite(duration) && duration > 0) durationRef.current = Math.round(duration);
        setPosition(position);
        if (isFinite(duration) && duration > 0) setDuration(duration);

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
      player.on("audioTracks", (event: { tracks?: AudioTrack[]; currentTrack?: number }) => {
        if (unmountedRef.current) return;
        const tracks: AudioTrack[] = event?.tracks ?? player.getAudioTracks() ?? [];
        const active = typeof event?.currentTrack === "number"
          ? event.currentTrack
          : player.getCurrentAudioTrack();
        setAudioTracks(tracks);
        setCurrentAudioTrack(Math.max(0, active));
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

      player.on("audioTrackChanged", (event: { tracks?: AudioTrack[]; currentTrack?: number }) => {
        if (unmountedRef.current) return;
        if (event?.tracks) setAudioTracks(event.tracks);
        const active = typeof event?.currentTrack === "number"
          ? event.currentTrack
          : player.getCurrentAudioTrack();
        setCurrentAudioTrack(Math.max(0, active));
      });

      // O manifesto HLS do Player 1 fornece Auto + 360p + 720p. Como os
      // controles nativos do JW estão ocultos, espelha a API no menu customizado.
      player.on("levels", (event: { levels?: QualityLevel[] }) => {
        if (unmountedRef.current) return;
        const levels: QualityLevel[] = event?.levels ?? player.getQualityLevels() ?? [];
        setQualityLevels(levels);
        const desired = userQualityRef.current;
        if (desired !== null && desired >= 0 && desired < levels.length) {
          player.setCurrentQuality(desired);
          setCurrentQuality(desired);
        } else {
          setCurrentQuality(Math.max(0, player.getCurrentQuality?.() ?? 0));
        }
      });

      player.on("levelsChanged", (event: { currentQuality?: number }) => {
        if (unmountedRef.current) return;
        const active = typeof event?.currentQuality === "number"
          ? event.currentQuality
          : player.getCurrentQuality?.();
        setCurrentQuality(Math.max(0, active ?? 0));
      });

      player.on("visualQuality", (event: { mode?: string; level?: QualityLevel }) => {
        if (unmountedRef.current) return;
        const rawLabel = event?.level?.label?.trim();
        const resolved = rawLabel && rawLabel.toLowerCase() !== "auto"
          ? rawLabel
          : event?.level?.height
            ? `${event.level.height}p`
            : "";
        setVisualQualityLabel(event?.mode === "auto" ? resolved : "");
      });

      // A lista sempre inclui o item 0 (legendas desligadas). Na primeira
      // carga, replica o EmbedMovies e ativa automaticamente a faixa portuguesa.
      player.on("captionsList", (event: { tracks?: CaptionTrack[]; track?: number }) => {
        if (unmountedRef.current) return;
        const captions: CaptionTrack[] = event?.tracks ?? player.getCaptionsList?.() ?? [];
        player.setCaptions?.(jwCaptionStyles(captionPreferencesRef.current));
        setCaptionTracks(captions);
        setCurrentCaption(Math.max(0, event?.track ?? player.getCurrentCaptions?.() ?? 0));
        if (captions.length <= 1) return;

        const desired = userCaptionRef.current;
        if (desired !== null && desired >= 0 && desired < captions.length) {
          player.setCurrentCaptions(desired);
          return;
        }

        const ptIdx = captions.findIndex((track) => {
          const name = `${track.label ?? ""} ${track.language ?? ""}`.toLowerCase();
          return name.includes("pt") || name.includes("por") || name.includes("portugu");
        });
        if (ptIdx > 0) player.setCurrentCaptions(ptIdx);
      });

      player.on("captionsChanged", (event: { tracks?: CaptionTrack[]; track?: number }) => {
        if (unmountedRef.current) return;
        if (event?.tracks) setCaptionTracks(event.tracks);
        setCurrentCaption(Math.max(0, event?.track ?? player.getCurrentCaptions?.() ?? 0));
      });

      player.on("volume", ({ volume: vol }: any) => {
        if (!unmountedRef.current) setVolume(vol / 100);
      });
      player.on("mute", ({ mute: m }: any) => {
        if (!unmountedRef.current) setMuted(m);
      });

      // Renova o token CDN (rola3/4 no Electron) de forma transparente: extrai uma nova
      // URL via IPC nativo e troca a fonte do player sem destruí-lo, preservando posição,
      // faixa de áudio e legenda. Protegida por debounce + lock + timeout de segurança.
      const REEXTRACT_BASE_DELAY_MS = 500;
      const REEXTRACT_MAX_DELAY_MS = 8000; // backoff exponencial: 500ms → 1s → 2s → 4s → 8s (cap)
      const REEXTRACT_SAFETY_TIMEOUT_MS = 30000; // SuperFlix percorre múltiplas páginas/redirects no dispositivo
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
            const renewedType = data.tipo === "mp4" ? "mp4" : "hls";
            const renewedTracks = (data.subtitles ?? []).map((track: SubtitleTrack, index: number) => ({
              file: buildElectronProxyUrl(track.file, track.referer || data.referer),
              label: track.label || "Português",
              kind: "captions",
              default: track.default ?? index === 0,
            }));
            const newManifestDomain = (() => { try { return new URL(data.stream).hostname; } catch { return "?"; } })();

            // [DIAG] Contexto da renovação — remover após confirmar causa dos 500 em .woff
            const prevItem = jwRef.current.getPlaylistItem?.();
            const prevRawUrl: string = prevItem?.file || prevItem?.sources?.[0]?.file || "desconhecido";
            console.log(`[diag/renewal] URL anterior (proxy): ${prevRawUrl.slice(0, 120)}`);
            console.log(`[diag/renewal] URL nova (proxy):     ${newUrl.slice(0, 120)}`);
            console.log(`[diag/renewal] Domínio CDN novo:     ${newManifestDomain}`);

            recoveryLog("log", "token-renewal-success", myGeneration, attempt, fi, len, pos, sinceRenewal,
              `tipo=${renewedType}; domínio=${newManifestDomain}; load+${pos > 5 ? `seek(${pos}s)` : "play"}`);

            // Suprime "error" por 2s: hls.js pode emitir eventos atrasados da instância
            // anterior logo após load() trocar a fonte.
            suppressErrorUntilRef.current = Date.now() + 2000;
            lastReExtractSuccessAtRef.current = Date.now();
            // O novo token tem validade própria; sem isso o agendamento preventivo
            // continuaria mirando o horário do token que acabou de ser substituído.
            streamExpiresAtRef.current = data.expiresAt ?? null;
            lastLoadAtRef.current = Date.now(); // [DIAG]
            jwRef.current.load([{ file: newUrl, type: renewedType, tracks: renewedTracks }]);
            setSubtitleTracks(renewedTracks);
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

      // Renovação preventiva: o SuperFlix declara `exp` no token da cadeia. Renovar
      // pouco antes evita que o usuário veja o erro de token expirado no meio do
      // episódio. Só age dentro de uma janela plausível — um `exp` muito curto ou
      // muito longo provavelmente não descreve a validade da mídia, e nesse caso o
      // comportamento antigo (renovar ao falhar) continua valendo.
      const EXPIRY_RENEW_MARGIN_MS = 60_000;
      const EXPIRY_MIN_AHEAD_MS = 120_000;
      // Um page_token real do SuperFlix mediu 6h00m23s de validade. Com o teto em
      // exatamente 6h o agendamento era descartado por 23 segundos e nunca rodava.
      const EXPIRY_MAX_AHEAD_MS = 12 * 60 * 60 * 1000;

      if (expiryTimerRef.current) { clearTimeout(expiryTimerRef.current); expiryTimerRef.current = null; }
      const expiresAt = streamExpiresAtRef.current;
      const embedUrlForExpiry = fonte?.embedUrl;
      const aheadMs = expiresAt ? expiresAt - Date.now() : 0;
      if (
        expiresAt && embedUrlForExpiry &&
        aheadMs >= EXPIRY_MIN_AHEAD_MS && aheadMs <= EXPIRY_MAX_AHEAD_MS &&
        (window as any).obaflixDesktop
      ) {
        expiryTimerRef.current = setTimeout(() => {
          expiryTimerRef.current = null;
          if (unmountedRef.current || reExtractingRef.current) return;
          // Pausado ou já em erro: a renovação reativa cuida quando voltar a tocar.
          if (jwRef.current?.getState?.() !== "playing") return;
          recoveryLog("log", "token-expiry", null, reExtractCountRef.current + 1,
            fonteIdx, allFontes.length, progressoRef.current, -1,
            `token expira em ${Math.round(EXPIRY_RENEW_MARGIN_MS / 1000)}s; renovando antes`);
          runReExtract(embedUrlForExpiry, fonteIdx, allFontes.length);
        }, aheadMs - EXPIRY_RENEW_MARGIN_MS);
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
        logEtapa(
          rotuloDiag,
          classificarEtapa({ url: srcUrl, http: httpStatus, jwCode: e?.code, mensagem: e?.message }),
          { url: srcUrl, http: httpStatus, jwCode: e?.code, ms: msSinceLoad },
        );

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

        // Web MP4: re-extrai link fresco do mesmo servidor antes de trocar de fonte.
        // Cobre expiração de cnvs_token (CDN Webcine assina URLs com TTL curto).
        // Só entra se o erro for de rede — 404/403, timeout JW (302xxx) ou sem status HTTP.
        // Erros de codec (JW >= 331000) ou arquivo corrompido vão direto para fallback.
        const isNetworkError =
          httpStatus === 404 || httpStatus === 403 ||
          (e?.code >= 302000 && e?.code < 310000) ||          // erros de carga JW
          (!httpStatus && (e?.code || 0) < 331000);            // erro sem status HTTP, não codec
        if (!inElectron && streamTipo === "mp4" && !initialLoadRef.current
            && pos > 0 && isNetworkError
            && reExtractCountRef.current < REEXTRACT_MAX_CONSECUTIVE_FAILURES) {
          if (reExtractingRef.current) return;

          // Cooldown: se a última tentativa neste servidor falhou, espera antes de tentar de novo
          if (Date.now() < mp4CooldownUntilRef.current) {
            const waitMs = mp4CooldownUntilRef.current - Date.now();
            recoveryLog("warn", "recover_cooldown", null, null, fi, len, pos, sinceRenewal,
              `cooldown ativo: ${Math.ceil(waitMs / 1000)}s restantes → fallback imediato`);
            fallback("source-switch", "warn",
              `cooldown → switches=${serverSwitchCountRef.current} fi=${fi}→${fi < len - 1 ? fi + 1 : "error"}`);
            return;
          }

          reExtractingRef.current = true;
          reExtractCountRef.current += 1;
          const attempt = reExtractCountRef.current;
          const myGeneration = ++reExtractGenerationRef.current;
          recoveryLog("log", "recover_start", myGeneration, attempt, fi, len, pos, sinceRenewal,
            `MP4 web re-extract (tentativa ${attempt}; http=${httpStatus ?? "n/a"}; jwCode=${e?.code ?? "n/a"})`);

          setRecovering(true);

          const abortCtrl = new AbortController();
          const safetyTimer = setTimeout(() => {
            abortCtrl.abort();
            reExtractingRef.current = false;
            setRecovering(false);
            if (unmountedRef.current || reExtractGenerationRef.current !== myGeneration) return;
            mp4CooldownUntilRef.current = Date.now() + 45000;
            recoveryLog("warn", "recover_failed", myGeneration, attempt, fi, len, pos, sinceRenewal,
              `timeout ${REEXTRACT_SAFETY_TIMEOUT_MS}ms; cooldown 45s; switches=${serverSwitchCountRef.current}`);
            fallback("source-switch", "warn",
              `timeout → fi=${fi}→${fi < len - 1 ? fi + 1 : "error"}`);
          }, REEXTRACT_SAFETY_TIMEOUT_MS);

          (async () => {
            try {
              const tokenRes = await fetch("/api/player/token", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ embedUrl }),
                signal: abortCtrl.signal,
              });
              if (!tokenRes.ok) throw new Error("Falha ao obter token");
              const { playToken } = await tokenRes.json();

              const extractRes = await fetch(
                `/api/player/extract?url=${encodeURIComponent(embedUrl)}&playToken=${encodeURIComponent(playToken)}`,
                { signal: abortCtrl.signal },
              );
              const data = await extractRes.json();
              if (!extractRes.ok || (!data.streamToken && !data.stream)) throw new Error(data.error || "Stream vazio");

              clearTimeout(safetyTimer);
              reExtractingRef.current = false;
              setRecovering(false);
              if (unmountedRef.current || reExtractGenerationRef.current !== myGeneration) return;

              const newUrl = data.tipo === "mp4_direct"
                ? data.stream
                : (data.streamToken.startsWith("/")
                  ? data.streamToken
                  : `/api/player/proxy?t=${encodeURIComponent(data.streamToken)}`);

              // Atualiza cache de URL para que seeks futuros usem o link renovado
              directStreamRef.current = newUrl;

              recoveryLog("log", "recover_success", myGeneration, attempt, fi, len, pos, sinceRenewal,
                `novo link; seek(${pos}s); switches=${serverSwitchCountRef.current}`);
              suppressErrorUntilRef.current = Date.now() + 2000;
              lastReExtractSuccessAtRef.current = Date.now();
              lastLoadAtRef.current = Date.now();
              jwRef.current!.load([{ file: newUrl, type: "mp4" }]);
              if (pos > 5) {
                jwRef.current!.once("firstFrame", () => {
                  if (!jwRef.current) return;
                  const dur = jwRef.current.getDuration?.();
                  const validDuration = typeof dur === "number" && isFinite(dur) && dur > 0;
                  if (!validDuration || pos < dur) jwRef.current.seek(pos);
                });
              }
              jwRef.current!.play();
            } catch (err: any) {
              clearTimeout(safetyTimer);
              reExtractingRef.current = false;
              setRecovering(false);
              if (err?.name === "AbortError" || unmountedRef.current) return;
              if (reExtractGenerationRef.current !== myGeneration) return;
              mp4CooldownUntilRef.current = Date.now() + 45000;
              recoveryLog("warn", "recover_failed", myGeneration, attempt, fi, len, pos, sinceRenewal,
                `${err?.message ?? String(err)}; cooldown 45s; switches=${serverSwitchCountRef.current}`);
              fallback("source-switch", "warn",
                `erro → fi=${fi}→${fi < len - 1 ? fi + 1 : "error"}`);
            }
          })();
          return;
        }

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

    });

    return () => {
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      if (reExtractDebounceRef.current) { clearTimeout(reExtractDebounceRef.current); reExtractDebounceRef.current = null; }
      if (expiryTimerRef.current) { clearTimeout(expiryTimerRef.current); expiryTimerRef.current = null; }
      if (jwRef.current) { try { jwRef.current.remove(); } catch {} jwRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, streamTipo, subtitleTracks]);

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

    const onPlay = () => {
      setPlaying(true);
      setStatus("playing");
      setAutoPlayBlocked(false);
      resetControlsTimerRef.current();
    };
    const onPause = () => {
      setPlaying(false);
      setControlsVisible(true);
      if (controlsTimerRef.current) { clearTimeout(controlsTimerRef.current); controlsTimerRef.current = null; }
      saveProgress();
    };
    const onWaiting = () => setStatus("loading");
    const onCanPlay = () => setStatus("playing");
    const onVolumeChange = () => { setVolume(video.volume); setMuted(video.muted); };
    const onTimeUpdate = () => {
      const ct = video.currentTime;
      const dur = video.duration;
      progressoRef.current = Math.floor(ct);
      if (isFinite(dur)) durationRef.current = Math.round(dur);
      setPosition(ct);
      if (isFinite(dur) && dur > 0) setDuration(dur);

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
    video.addEventListener("volumechange", onVolumeChange);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamTipo, nextUrl, saveProgress]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || streamTipo !== "native") return;

    const available: CaptionTrack[] = [
      { id: "off", label: "Desativadas" },
      ...subtitleTracks.map((track, index) => ({
        id: `native-${index}`,
        label: track.label || "Português",
      })),
    ];
    setCaptionTracks(available);

    if (subtitleTracks.length === 0) {
      setCurrentCaption(0);
      return;
    }

    const requested = userCaptionRef.current;
    const active = requested !== null && requested >= 0 && requested < available.length
      ? requested
      : 1;
    Array.from(video.textTracks).forEach((track, index) => {
      track.mode = active === index + 1 ? "showing" : "disabled";
    });
    setCurrentCaption(active);
  }, [streamTipo, subtitleTracks]);

  const selectCaptionTrack = (index: number) => {
    userCaptionRef.current = index;
    if (jwRef.current?.setCurrentCaptions) {
      jwRef.current.setCurrentCaptions(index);
    }
    if (videoRef.current && streamTipo === "native") {
      Array.from(videoRef.current.textTracks).forEach((track, trackIndex) => {
        track.mode = index === trackIndex + 1 ? "showing" : "disabled";
      });
    }
    setCurrentCaption(index);
  };

  const btnCls = "flex-shrink-0 w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all duration-200 bg-white/10 text-white hover:bg-white hover:text-black active:bg-white active:text-black";
  const pct = duration > 0 ? Math.min((position / duration) * 100, 100) : 0;
  const showCustomControls = streamTipo !== "iframe";
  const showOverlay = !playing || status !== "playing" || controlsVisible || showPlaybackSettings || showSources;
  const hasPlaybackSettings = qualityLevels.length > 1 || audioTracks.length > 1 || captionTracks.length > 1;

  const qualityName = (level: QualityLevel, index: number) => {
    if (index === 0) return visualQualityLabel ? `Automática (${visualQualityLabel})` : "Automática";
    return level.label || (level.height ? `${level.height}p` : `Qualidade ${index}`);
  };

  const languageName = (track: AudioTrack | CaptionTrack, fallback: string) => {
    const raw = ("name" in track ? track.name : undefined) || track.label || track.language || fallback;
    const normalized = raw.toLowerCase();
    if (normalized === "off" || normalized.includes("desativ")) return "Desativadas";
    if (normalized.includes("por") || normalized === "pt" || normalized.startsWith("pt-")) return "Português";
    if (normalized.includes("eng") || normalized === "en" || normalized.startsWith("en-")) return "Inglês";
    return raw;
  };

  const resolvedCaptionFontSize = captionFontSize(captionPreferences);
  const captionBackground = `rgba(16, 16, 20, ${captionPreferences.backgroundOpacity / 100})`;
  const captionColor = CAPTION_COLORS[captionPreferences.color].value;
  const captionShadow = captionTextShadow(captionPreferences.edgeStyle);
  const captionCss = `
    #jw-player-container .jw-text-track-container {
      bottom: clamp(4.75rem, 12vh, 8.5rem) !important;
    }
    #jw-player-container .jw-text-track-cue,
    #jw-player-container .jw-text-track-display span,
    #jw-player-container .jw-captions-text {
      color: ${captionColor} !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: ${resolvedCaptionFontSize}px !important;
      font-weight: 650 !important;
      line-height: 1.28 !important;
      letter-spacing: 0.005em !important;
      background: ${captionBackground} !important;
      padding: 0.08em 0.3em !important;
      border-radius: 0.12em !important;
      text-shadow: ${captionShadow} !important;
    }
    video[data-obaflix-player]::cue {
      color: ${captionColor};
      font-family: Arial, Helvetica, sans-serif;
      font-size: ${resolvedCaptionFontSize}px;
      font-weight: 650;
      line-height: 1.28;
      background-color: ${captionBackground};
      text-shadow: ${captionShadow};
    }
  `;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black select-none touch-none"
      onMouseMove={() => { if (playing && status === "playing") resetControlsTimerRef.current(); }}
    >
      <style>{captionCss}</style>
      {/* ── Video elements ── */}
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
          data-obaflix-player
          className="absolute inset-0 w-full h-full object-contain"
          playsInline
          preload="auto"
        >
          {subtitleTracks.map((track, index) => (
            <track
              key={`${track.file}-${index}`}
              src={track.file}
              kind="captions"
              srcLang={track.label?.toLowerCase().includes("ing") ? "en" : "pt-BR"}
              label={track.label || "Português"}
              default={track.default ?? index === 0}
            />
          ))}
        </video>
      )}

      {streamTipo === "iframe" && streamUrl && isSuperflixUrl(streamUrl) && status === "playing" && (
        <div className="absolute top-0 left-0 right-0 z-[9998] px-14 pt-4 pb-7 text-center pointer-events-none bg-gradient-to-b from-black/90 to-transparent">
          <p className="text-white text-[13px] md:text-sm leading-snug drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]">
            Escolha um servidor para assistir. Recomendamos o Servidor Alternativo, se estiver disponível.
          </p>
        </div>
      )}

      {streamTipo === "iframe" && streamUrl && (
        <iframe
          key={streamUrl}
          src={streamUrl}
          onLoad={() => {
            // Cross-origin não deixa ler o conteúdo, mas o evento de load chega.
            // É o sinal de que a tela de servidores já está desenhada e o
            // carregamento padrão pode sair.
            if (isSuperflixUrl(streamUrl)) setStatus("playing");
          }}
          className="absolute inset-0 w-full h-full border-0 touch-auto"
          allow={isSuperflixUrl(streamUrl)
            ? "autoplay *; encrypted-media *; picture-in-picture *; fullscreen *; clipboard-write *; accelerometer *; gyroscope *; web-share *"
            : "autoplay; fullscreen; picture-in-picture"}
          allowFullScreen
          referrerPolicy="origin-when-cross-origin"
          sandbox={isSuperflixUrl(streamUrl)
            ? undefined
            : "allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"}
          title={`${titulo} - player`}
        />
      )}

      {/* Mini spinner durante re-extração silenciosa de link MP4 */}
      {recovering && (
        <div className="absolute inset-0 z-[9997] flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2 bg-black/40 backdrop-blur-sm rounded-2xl px-5 py-3">
            <div className="w-6 h-6 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            <span className="text-white/70 text-[10px] font-medium tracking-wide">Reconectando</span>
          </div>
        </div>
      )}

      {/* Click-to-play zone (between video and controls overlay) */}
      {showCustomControls && (
        <div
          className="absolute inset-0 z-[9998]"
          onClick={() => {
            resetControlsTimerRef.current();
            if (jwRef.current) {
              const state = jwRef.current.getState?.();
              if (state === "playing") jwRef.current.pause();
              else jwRef.current.play();
            } else if (videoRef.current) {
              if (videoRef.current.paused) videoRef.current.play().catch(() => {});
              else videoRef.current.pause();
            }
          }}
        />
      )}

      {/* ── Main UI overlay ── */}
      <div
        className={`absolute inset-0 flex flex-col justify-between pointer-events-none z-[9999] transition-opacity duration-500 ${
          showOverlay ? "opacity-100" : "opacity-0"
        }`}
      >
        {/* ── Top bar ── */}
        <div className="pointer-events-auto px-3 pt-2 pb-6 bg-gradient-to-b from-black/80 via-black/30 to-transparent md:px-8 md:pt-4 md:pb-10 landscape:pb-3">
          <div className="flex items-center justify-between gap-2">

            {/* Left: back + title */}
            <div className="flex items-center min-w-0 gap-2 md:gap-3">
              <button
                title="Voltar"
                className={btnCls}
                onClick={async () => {
                  saveProgress();
                  // Ao sair do player de propósito, encerra o fullscreen. Nas trocas de
                  // episódio, ele é preservado porque o documentElement não é desmontado.
                  if (document.fullscreenElement) {
                    await document.exitFullscreen?.().catch(() => {});
                  }
                  router.push(conteudoTipo === "filme" ? `/filme/${conteudoId}` : `/serie/${conteudoId}`);
                }}
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

            {/* Right: servidor, áudio, cast, prev, next, report */}
            <div className="flex items-center gap-1 md:gap-1.5 flex-shrink-0">

              {/* Servidor dropdown */}
              {allFontes.length > 0 && (
                <div className="relative">
                  <button
                    title="Selecionar servidor"
                    className={`h-10 md:h-12 px-3 md:px-4 rounded-full flex items-center gap-1.5 flex-shrink-0 transition-all duration-200 bg-white/10 text-white text-xs md:text-sm font-medium hover:bg-white hover:text-black active:bg-white active:text-black${showSources ? " !bg-white !text-black" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowPlaybackSettings(false);
                      setShowSources((s) => !s);
                    }}
                  >
                    Servidor
                    <ChevronRight className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${showSources ? "rotate-90" : ""}`} />
                  </button>
                  {showSources && (
                    <div className="absolute right-0 top-full mt-2 bg-zinc-900/95 border border-white/10 rounded-xl overflow-hidden min-w-[140px] shadow-2xl">
                      {allFontes.map((f, i) => {
                        const falhou = servidoresFalhos[f.embedUrl];
                        return (
                          <button
                            key={i}
                            onClick={() => { switchFonte(i); setShowSources(false); }}
                            className={`w-full text-left px-4 py-2.5 text-xs transition-all ${
                              fonteIdx === i
                                ? "bg-[#E50914] text-white font-semibold"
                                : falhou
                                  ? "text-white/30 hover:bg-white/10"
                                  : "text-white/70 hover:bg-white/10 hover:text-white"
                            }`}
                          >
                            {/* Servidores internos do mesmo player não viram Player 6, 7... */}
                            {f.servidor ? `${f.label} · ${f.servidor}` : f.label}
                            {falhou && (
                              <span className="block text-[10px] text-white/30 mt-0.5">indisponível</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Download — só no app desktop (ver podeBaixar) */}
              {podeBaixar && (
                <div className="relative">
                  <button
                    title="Baixar mídia"
                    className={`h-10 md:h-12 px-3 md:px-4 rounded-full flex items-center gap-1.5 flex-shrink-0 transition-all duration-200 bg-white/10 text-white text-xs md:text-sm font-medium hover:bg-white hover:text-black active:bg-white active:text-black${showDownload ? " !bg-white !text-black" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowPlaybackSettings(false);
                      setShowSources(false);
                      if (downloadProgresso) return; // já baixando: o clique abre o painel abaixo
                      setShowDownload((s) => !s);
                    }}
                  >
                    {downloadProgresso ? `Baixando ${downloadProgresso.pct}%` : "Baixar"}
                  </button>

                  {showDownload && !downloadProgresso && (
                    <div className="absolute right-0 top-full mt-2 bg-zinc-900/95 border border-white/10 rounded-xl overflow-hidden min-w-[210px] shadow-2xl">
                      <button
                        onClick={() => iniciarDownload("completo")}
                        className="w-full text-left px-4 py-2.5 text-xs text-white/80 hover:bg-white/10 hover:text-white transition-all"
                      >
                        Baixar conteúdo completo
                      </button>
                      <div className="border-t border-white/10" />
                      <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide text-white/35">
                        Baixar trecho a partir daqui
                      </div>
                      {[60, 300, 600].map((seg) => (
                        <button
                          key={seg}
                          onClick={() => iniciarDownload("trecho", seg)}
                          className="w-full text-left px-4 py-2 text-xs text-white/70 hover:bg-white/10 hover:text-white transition-all"
                        >
                          próximos {seg / 60} min
                        </button>
                      ))}
                    </div>
                  )}

                  {downloadProgresso && (
                    <div className="absolute right-0 top-full mt-2 bg-zinc-900/95 border border-white/10 rounded-xl p-3 min-w-[220px] shadow-2xl">
                      <div className="flex items-center justify-between text-[11px] text-white/70 mb-2">
                        <span>
                          {downloadProgresso.total > 0
                            ? `${downloadProgresso.atual}/${downloadProgresso.total} partes`
                            : "preparando…"}
                        </span>
                        <span>{(downloadProgresso.bytes / 1048576).toFixed(1)} MB</span>
                      </div>
                      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#E50914] transition-all duration-300"
                          style={{ width: `${downloadProgresso.pct}%` }}
                        />
                      </div>
                      <button
                        onClick={() => desktopBridge?.cancelDownload?.()}
                        className="mt-2.5 w-full text-center text-[11px] text-white/50 hover:text-white transition-colors"
                      >
                        Cancelar
                      </button>
                    </div>
                  )}

                  {downloadResultado && !downloadProgresso && (
                    <div className="absolute right-0 top-full mt-2 bg-zinc-900/95 border border-white/10 rounded-xl p-3 min-w-[220px] shadow-2xl">
                      {downloadResultado.erro ? (
                        <p className="text-[11px] text-white/70 leading-snug">{downloadResultado.erro}</p>
                      ) : (
                        <>
                          <p className="text-[11px] text-white/70 mb-2">Salvo em Downloads</p>
                          <button
                            onClick={() => desktopBridge?.revealDownload?.(downloadResultado.caminho)}
                            className="w-full text-center text-[11px] text-white bg-white/10 hover:bg-white/20 rounded-lg py-1.5 transition-colors"
                          >
                            Abrir pasta
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setDownloadResultado(null)}
                        className="mt-2 w-full text-center text-[11px] text-white/40 hover:text-white/70 transition-colors"
                      >
                        Fechar
                      </button>
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

              {/* Episódio anterior */}
              {prevUrl && (
                <button
                  title="Episódio anterior"
                  className={btnCls}
                  onClick={() => { saveProgress(); router.push(prevUrl); }}
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}

              {/* Próximo episódio */}
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

              {/* Reportar */}
              <button title="Reportar problema" className={btnCls}>
                <Flag className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* ── Middle: logo + info ── */}
        {showCustomControls && <div className="self-start pointer-events-none px-3 sm:px-4 md:px-12 max-w-[240px] sm:max-w-sm md:max-w-3xl lg:max-w-4xl xl:max-w-5xl [@media(max-height:540px)]:max-w-[220px] [@media(max-height:540px)]:px-2.5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
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
        </div>}

        {/* ── Bottom: controles customizados ── */}
        {showCustomControls ? (
          <div className="pointer-events-auto px-3 pt-4 pb-2 bg-gradient-to-t from-black/80 via-black/30 to-transparent md:px-8 md:pt-10 landscape:pt-2 md:pb-4">

            {/* Barra de progresso */}
            <div className="flex items-center gap-2 mb-2 md:gap-3 md:mb-3">
              <span className="text-white text-[10px] md:text-xs font-medium tabular-nums min-w-[32px] md:min-w-[42px] text-right">
                {formatTime(position)}
              </span>
              <div
                className="relative flex items-center flex-1 h-10 cursor-pointer group/seek md:h-6 touch-none"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const newPos = frac * duration;
                  if (jwRef.current) jwRef.current.seek(newPos);
                  else if (videoRef.current) videoRef.current.currentTime = newPos;
                }}
              >
                <div className="absolute left-0 right-0 h-[3px] rounded-full bg-white/20 transition-all duration-200 group-hover/seek:h-[5px]">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-[#E50914]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-[#E50914] ring-2 ring-white/30 shadow-lg transition-transform duration-200 scale-0 group-hover/seek:scale-100 pointer-events-none"
                  style={{ left: `calc(${pct}% - 8px)` }}
                />
              </div>
              <span className="text-white text-[10px] md:text-xs font-medium tabular-nums min-w-[32px] md:min-w-[42px]">
                {formatTime(duration)}
              </span>
            </div>

            {/* Botões de controle */}
            <div className="flex items-center justify-between">

              {/* Esquerda: reiniciar + volume */}
              <div className="flex items-center gap-1 md:gap-1.5">
                <button
                  title="Reiniciar"
                  className={btnCls}
                  onClick={() => {
                    if (jwRef.current) jwRef.current.seek(0);
                    else if (videoRef.current) videoRef.current.currentTime = 0;
                  }}
                >
                  <RotateCcw className="w-4 h-4 md:w-5 md:h-5" />
                </button>

                {/* Volume (desktop) */}
                <div className="hidden md:flex items-center gap-1 group/vol">
                  <button
                    title={muted || volume === 0 ? "Ativar som" : "Silenciar"}
                    className={btnCls}
                    onClick={() => {
                      const newMuted = !muted;
                      if (jwRef.current) jwRef.current.setMute(newMuted);
                      else if (videoRef.current) videoRef.current.muted = newMuted;
                      setMuted(newMuted);
                    }}
                  >
                    {muted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={muted ? 0 : volume}
                    className="w-0 overflow-hidden transition-all duration-300 cursor-pointer group-hover/vol:w-20 accent-[#E50914]"
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setVolume(v);
                      setMuted(v === 0);
                      if (jwRef.current) { jwRef.current.setVolume(v * 100); if (v > 0) jwRef.current.setMute(false); }
                      else if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0; }
                    }}
                  />
                </div>
              </div>

              {/* Centro: -10s + play/pause + +10s */}
              <div className="flex items-center gap-2 md:gap-3">
                <button
                  title="-10 segundos"
                  className={btnCls}
                  onClick={() => {
                    const newPos = Math.max(0, progressoRef.current - 10);
                    if (jwRef.current) jwRef.current.seek(newPos);
                    else if (videoRef.current) videoRef.current.currentTime = newPos;
                  }}
                >
                  <span className="text-xs md:text-sm font-bold leading-none">-10s</span>
                </button>

                <button
                  title={playing ? "Pausar" : "Reproduzir"}
                  className="flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center transition-all duration-200 bg-white/15 text-white hover:bg-white hover:text-black hover:scale-105 active:scale-95"
                  onClick={() => {
                    if (jwRef.current) {
                      const state = jwRef.current.getState?.();
                      if (state === "playing") jwRef.current.pause();
                      else jwRef.current.play();
                    } else if (videoRef.current) {
                      if (videoRef.current.paused) videoRef.current.play().catch(() => {});
                      else videoRef.current.pause();
                    }
                  }}
                >
                  {playing
                    ? <Pause className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" strokeWidth={0} />
                    : <Play className="w-5 h-5 md:w-6 md:h-6 ml-0.5" fill="currentColor" strokeWidth={0} />
                  }
                </button>

                <button
                  title="+10 segundos"
                  className={btnCls}
                  onClick={() => {
                    const newPos = progressoRef.current + 10;
                    if (jwRef.current) jwRef.current.seek(newPos);
                    else if (videoRef.current) videoRef.current.currentTime = Math.min(newPos, (videoRef.current.duration || Infinity) - 1);
                  }}
                >
                  <span className="text-xs md:text-sm font-bold leading-none">+10s</span>
                </button>
              </div>

              {/* Direita: ajustes + próximo ep + tela cheia */}
              <div className="flex items-center gap-1 md:gap-1.5">
                {hasPlaybackSettings && (
                  <div className="relative">
                    <button
                      title="Qualidade, áudio e legendas"
                      className={`${btnCls}${showPlaybackSettings ? " !bg-white !text-black" : ""}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setShowSources(false);
                        setShowPlaybackSettings((visible) => !visible);
                        resetControlsTimerRef.current();
                      }}
                    >
                      <Settings2 className="w-5 h-5" />
                    </button>

                    {showPlaybackSettings && (
                      <div
                        className="absolute right-0 bottom-full mb-2 w-[min(21rem,calc(100vw-1rem))] max-h-[72dvh] overflow-y-auto overscroll-contain touch-auto rounded-2xl border border-white/10 bg-zinc-950 p-2 text-white shadow-2xl sm:max-h-[62vh]"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <p className="px-2 pb-2 pt-1 text-xs font-semibold text-white/90">Reprodução</p>

                        {qualityLevels.length > 1 && (
                          <div className="mb-2 border-t border-white/10 pt-2">
                            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/45">Qualidade</p>
                            {qualityLevels.map((level, index) => (
                              <button
                                key={`quality-${index}`}
                                className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition-colors ${currentQuality === index ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
                                onClick={() => {
                                  userQualityRef.current = index === 0 ? null : index;
                                  jwRef.current?.setCurrentQuality?.(index);
                                  setCurrentQuality(index);
                                }}
                              >
                                <span>{qualityName(level, index)}</span>
                                {currentQuality === index && <Check className="h-4 w-4 text-[#E50914]" />}
                              </button>
                            ))}
                          </div>
                        )}

                        {audioTracks.length > 1 && (
                          <div className="mb-2 border-t border-white/10 pt-2">
                            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/45">Áudio</p>
                            {audioTracks.map((track, index) => (
                              <button
                                key={`audio-${index}`}
                                className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition-colors ${currentAudioTrack === index ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
                                onClick={() => {
                                  userAudioTrackRef.current = index;
                                  jwRef.current?.setCurrentAudioTrack?.(index);
                                  setCurrentAudioTrack(index);
                                }}
                              >
                                <span>{languageName(track, `Faixa ${index + 1}`)}</span>
                                {currentAudioTrack === index && <Check className="h-4 w-4 text-[#E50914]" />}
                              </button>
                            ))}
                          </div>
                        )}

                        {captionTracks.length > 1 && (
                          <div className="border-t border-white/10 pt-2">
                            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/45">Legendas</p>
                            {captionTracks.map((track, index) => (
                              <button
                                key={`caption-${String(track.id ?? index)}`}
                                className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition-colors ${currentCaption === index ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
                                onClick={() => selectCaptionTrack(index)}
                              >
                                <span>{index === 0 ? "Desativadas" : languageName(track, `Legenda ${index}`)}</span>
                                {currentCaption === index && <Check className="h-4 w-4 text-[#E50914]" />}
                              </button>
                            ))}

                            <button
                              className="mt-1 flex min-h-10 w-full items-center justify-between rounded-lg px-2 text-left text-xs font-semibold text-zinc-100/85 transition-colors hover:bg-zinc-100/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100/60"
                              aria-expanded={showCaptionAppearance}
                              onClick={() => setShowCaptionAppearance((visible) => !visible)}
                            >
                              <span>Personalizar legenda</span>
                              <ChevronRight className={`h-4 w-4 transition-transform duration-200 ${showCaptionAppearance ? "rotate-90" : ""}`} />
                            </button>

                            {showCaptionAppearance && (
                              <div className="px-2 pb-2 pt-1">
                                <div
                                  className="mb-4 flex min-h-16 items-center justify-center rounded-xl bg-zinc-900 px-3 py-3 text-center"
                                  aria-label="Prévia da legenda"
                                >
                                  <span
                                    style={{
                                      color: captionColor,
                                      backgroundColor: captionBackground,
                                      fontFamily: "Arial, Helvetica, sans-serif",
                                      fontSize: `${Math.min(22, resolvedCaptionFontSize)}px`,
                                      fontWeight: 650,
                                      lineHeight: 1.28,
                                      padding: "0.08em 0.3em",
                                      textShadow: captionShadow,
                                    }}
                                  >
                                    Exemplo de legenda
                                  </span>
                                </div>

                                <fieldset>
                                  <legend className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/45">Cor</legend>
                                  <div className="flex gap-2">
                                    {(Object.entries(CAPTION_COLORS) as [CaptionColor, { label: string; value: string }][]).map(([key, option]) => (
                                      <button
                                        key={key}
                                        title={option.label}
                                        aria-label={`Cor ${option.label}`}
                                        aria-pressed={captionPreferences.color === key}
                                        className={`h-10 flex-1 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100/70 ${captionPreferences.color === key ? "border-zinc-100/80 bg-zinc-100/10" : "border-zinc-100/10 hover:border-zinc-100/30"}`}
                                        onClick={() => setCaptionPreferences((current) => ({ ...current, color: key }))}
                                      >
                                        <span className="mx-auto block h-4 w-4 rounded-full border border-zinc-950/20" style={{ backgroundColor: option.value }} />
                                      </button>
                                    ))}
                                  </div>
                                </fieldset>

                                <fieldset className="mt-4">
                                  <legend className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/45">Tamanho</legend>
                                  <div className="grid grid-cols-2 gap-1.5">
                                    {(Object.entries(CAPTION_SIZES) as [CaptionSize, { label: string; scale: number }][]).map(([key, option]) => (
                                      <button
                                        key={key}
                                        aria-pressed={captionPreferences.size === key}
                                        className={`min-h-10 rounded-lg px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100/70 ${captionPreferences.size === key ? "bg-zinc-100 text-zinc-950" : "bg-zinc-100/5 text-zinc-100/70 hover:bg-zinc-100/10 hover:text-zinc-100"}`}
                                        onClick={() => setCaptionPreferences((current) => ({ ...current, size: key }))}
                                      >
                                        {option.label}
                                      </button>
                                    ))}
                                  </div>
                                </fieldset>

                                <label className="mt-4 block">
                                  <span className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-white/45">
                                    <span>Fundo</span>
                                    <span>{captionPreferences.backgroundOpacity}%</span>
                                  </span>
                                  <input
                                    className="mt-2 h-10 w-full accent-red-600"
                                    type="range"
                                    min="0"
                                    max="100"
                                    step="10"
                                    value={captionPreferences.backgroundOpacity}
                                    onChange={(event) => setCaptionPreferences((current) => ({
                                      ...current,
                                      backgroundOpacity: Number(event.target.value),
                                    }))}
                                  />
                                </label>

                                <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-white/45">
                                  Contorno
                                  <select
                                    className="mt-2 min-h-10 w-full rounded-lg border border-zinc-100/10 bg-zinc-900 px-3 text-xs font-medium normal-case tracking-normal text-zinc-100 outline-none focus:border-zinc-100/40"
                                    value={captionPreferences.edgeStyle}
                                    onChange={(event) => setCaptionPreferences((current) => ({
                                      ...current,
                                      edgeStyle: event.target.value as CaptionEdgeStyle,
                                    }))}
                                  >
                                    <option value="uniform">Contorno forte</option>
                                    <option value="dropshadow">Sombra</option>
                                    <option value="none">Sem contorno</option>
                                  </select>
                                </label>

                                <div className="mt-4 flex items-center justify-between border-t border-zinc-100/10 pt-3">
                                  <span className="text-[10px] text-zinc-100/45">Salvo neste aparelho</span>
                                  <button
                                    className="min-h-9 rounded-lg px-2 text-[11px] font-semibold text-zinc-100/65 transition-colors hover:bg-zinc-100/10 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100/70"
                                    onClick={() => setCaptionPreferences(DEFAULT_CAPTION_PREFERENCES)}
                                  >
                                    Restaurar padrão
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {nextUrl && (
                  <button
                    title="Próximo episódio"
                    className={`${btnCls} !w-auto px-3 gap-1`}
                    onClick={() => {
                      autoSkipDoneRef.current = true;
                      setNextEpCountdown(null);
                      nextEpCountdownActiveRef.current = false;
                      saveProgress().then(() => router.push(nextUrl));
                    }}
                  >
                    <span className="hidden sm:inline text-xs font-medium">Próximo</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                )}
                {pipDisponivel && (
                  <button
                    title={isPiP ? "Sair da janela flutuante" : "Janela flutuante"}
                    aria-label={isPiP ? "Sair da janela flutuante" : "Assistir em janela flutuante"}
                    aria-pressed={isPiP}
                    className={btnCls}
                    onClick={togglePiP}
                  >
                    <PictureInPicture2 className="w-5 h-5" />
                  </button>
                )}
                <button
                  title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
                  className={btnCls}
                  onClick={toggleFullscreen}
                >
                  {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="h-16 md:h-20 pointer-events-none" />
        )}
      </div>

      {/* ── Status overlays (z-[99999]) ── */}

      {/* Loading unificado: extração + buffering inicial do JW */}
      {(status === "extracting" || (status === "loading" && streamTipo !== "native")) && (
        <div className="absolute inset-0 z-[99999] flex flex-col items-center justify-center">
          {thumbUrl && (
            <div className="absolute inset-0 bg-cover bg-center scale-105" style={{ backgroundImage: `url(${thumbUrl})` }} />
          )}
          <div className="absolute inset-0 bg-black/80" />
          <div className="relative z-10 flex flex-col items-center gap-5 text-center px-8">
            <div className="w-12 h-12 border-4 border-white/20 border-t-[#E50914] rounded-full animate-spin" />
            <div className="flex flex-col items-center gap-1">
              <p className="text-white font-semibold text-base md:text-lg leading-snug">{titulo}</p>
              {temporada && numeroEp && (
                <p className="text-white/50 text-sm">T{temporada} EP{numeroEp}{nomeEpisodio ? ` · ${nomeEpisodio}` : ""}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Native buffering */}
      {status === "loading" && streamTipo === "native" && !autoPlayBlocked && (
        <div className="absolute inset-0 z-[99999] flex items-center justify-center">
          <div className="w-10 h-10 border-4 border-white/20 border-t-[#E50914] rounded-full animate-spin" />
        </div>
      )}

      {/* Autoplay bloqueado (native) */}
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

      {/* Erro */}
      {status === "error" && (
        <div className="absolute inset-0 z-[99999] flex flex-col items-center justify-center bg-black/75 gap-5">
          <AlertCircle size={44} className="text-[#E50914]" strokeWidth={1.5} />
          <p className="text-white/80 text-sm max-w-xs text-center leading-relaxed">{error}</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push(conteudoTipo === "filme" ? `/filme/${conteudoId}` : `/serie/${conteudoId}`)}
              className="flex items-center gap-2 border border-white/20 bg-white/10 text-white text-xs font-bold px-5 py-2.5 rounded-full hover:bg-white/20 transition"
            >
              <ArrowLeft size={15} /> Voltar
            </button>
            <button
              onClick={() => extract(fonte?.embedUrl ?? "")}
              className="bg-white text-black text-xs font-bold px-5 py-2.5 rounded-full hover:bg-zinc-200 transition"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      {/* Sem fontes */}
      {status === "idle" && allFontes.length === 0 && (
        <div className="absolute inset-0 z-[99999] flex flex-col gap-4 items-center justify-center">
          <p className="text-white/50 text-sm">Nenhuma fonte disponível</p>
          <button
            onClick={() => router.push(conteudoTipo === "filme" ? `/filme/${conteudoId}` : `/serie/${conteudoId}`)}
            className="flex items-center gap-2 border border-white/20 bg-white/10 text-white text-xs font-bold px-5 py-2.5 rounded-full"
          >
            <ArrowLeft size={15} /> Voltar
          </button>
        </div>
      )}

      {/* Auto-skip próximo episódio */}
      {nextEpCountdown !== null && nextUrl && (
        <div className="absolute bottom-28 right-4 z-[9999] md:bottom-32 md:right-6">
          <div className="flex items-center gap-4 bg-zinc-900/95 backdrop-blur-sm border border-white/10 rounded-2xl px-5 py-4 shadow-2xl">
            {/* Contador circular */}
            <div className="relative w-14 h-14 flex-shrink-0">
              <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
                <circle cx="28" cy="28" r="22" fill="none" stroke="white" strokeOpacity="0.12" strokeWidth="3" />
                <circle
                  cx="28" cy="28" r="22" fill="none" stroke="#E50914" strokeWidth="3"
                  strokeDasharray={`${2 * Math.PI * 22}`}
                  strokeDashoffset={`${2 * Math.PI * 22 * (1 - nextEpCountdown / 30)}`}
                  strokeLinecap="round"
                  style={{ transition: "stroke-dashoffset 1s linear" }}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-white font-bold text-base tabular-nums">
                {nextEpCountdown}
              </span>
            </div>

            <div>
              <p className="text-white/40 text-[10px] uppercase tracking-wider leading-none mb-1.5">Próximo episódio</p>
              {temporada && numeroEp && (
                <p className="text-white font-semibold text-sm leading-tight mb-3">
                  T{temporada} EP{(numeroEp ?? 0) + 1}
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    autoSkipDoneRef.current = true;
                    setNextEpCountdown(null);
                    nextEpCountdownActiveRef.current = false;
                    saveProgress().then(() => router.push(nextUrl));
                  }}
                  className="flex items-center gap-1 bg-[#E50914] hover:bg-[#f00] text-white text-xs font-semibold px-3 py-1.5 rounded-full transition-all"
                >
                  Assistir <ChevronRight size={12} />
                </button>
                <button
                  onClick={() => {
                    autoSkipDoneRef.current = true;
                    setNextEpCountdown(null);
                    nextEpCountdownActiveRef.current = false;
                  }}
                  className="text-white/40 hover:text-white/70 text-xs transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
