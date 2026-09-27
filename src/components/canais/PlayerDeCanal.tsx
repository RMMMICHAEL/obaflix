"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { X } from "lucide-react";
import type { ItemDeCanal } from "@/lib/canais/catalogo";
import {
  criarControleDeCanal,
  type ControleDeCanal,
  type ResultadoDePedido,
} from "@/lib/canais/handoff";
import { PlayerControls } from "@/components/player/PlayerControls";
import {
  ehTeclaDeSairDaTelaCheia,
  janelaOcupaATela,
  opcoesDeQualidade,
  seloDeResolucao,
} from "@/lib/canais/playerControles";
import { criarWatchdogDeStall } from "@/lib/canais/watchdogDeStall";

/**
 * Player de canal ao vivo.
 *
 * Motor de live (não VOD): `/play → streamUrl`, `criarControleDeCanal`,
 * re-resolução controlada, single-flight, teto 3/60s e watchdog de stall. Os
 * controles vêm do `PlayerControls` (mesma identidade do `CustomPlayer`).
 *
 * ## Dois modos de render
 *
 * - `inline` (Etapa 3): preenche a área de preview da tela de canais (lista +
 *   preview). Sem barra superior de "fechar"; tela cheia via Fullscreen API no
 *   próprio elemento. Um player por vez: o pai usa `key={canal.id}`, então trocar
 *   de canal desmonta este componente (o cleanup destrói hls, timers e listeners)
 *   e monta o novo.
 * - modal (legado): overlay `fixed inset-0` com barra de fechar. Mantido para não
 *   regredir chamadas existentes.
 *
 * Nada de `streamUrl` é persistido. O componente nunca vê provider/host/Referer.
 *
 * ## Sobreposição superior
 *
 * Logo real do canal (quando há `logoUrl` que carrega), `● AO VIVO` e o selo de
 * resolução — este só com altura **reportada pelo player** (nível do hls.js em
 * uso, ou `videoHeight` no HLS nativo). Nunca uma resolução presumida.
 */

/** Ações que o pai pode disparar (ex.: Enter na lista abre em tela cheia). */
export interface AcoesDoPlayerDeCanal {
  alternarTelaCheia: () => void;
}

type Estado =
  | { fase: "pedindo" }
  | { fase: "tocando"; primeiraUrl: string }
  | { fase: "erro"; mensagem: string; podeTentarDeNovo: boolean };

/** Acesso opcional ao Remote Playback (cast nativo do navegador/WebView). */
interface RemotePlaybackLike {
  state?: string;
  watchAvailability?: (cb: (available: boolean) => void) => Promise<number>;
  cancelWatchAvailability?: (id: number) => Promise<void>;
  prompt?: () => Promise<void>;
  addEventListener?: (tipo: string, cb: () => void) => void;
  removeEventListener?: (tipo: string, cb: () => void) => void;
}
/**
 * Espera antes de pedir o `/play` ao montar. Quem passa rápido por vários canais
 * desmonta o player antes disso e nenhum `/play` sai para os canais de passagem.
 */
const ATRASO_DE_ABERTURA_MS = 250;

function remoteDe(video: HTMLVideoElement | null): RemotePlaybackLike | null {
  if (!video) return null;
  const r = (video as unknown as { remote?: RemotePlaybackLike }).remote;
  return r && typeof r.prompt === "function" ? r : null;
}

/**
 * Pede a URL de reprodução ao `/play`.
 *
 * `reresolucao=false` é a abertura (pode cobrar anúncio); `true` é a continuação
 * após um erro de reprodução — o servidor resolve de novo e devolve uma
 * `streamUrl` nova, sem cobrar anúncio outra vez.
 */
async function pedirConcessao(
  canalId: string,
  reresolucao: boolean,
  concessaoAnuncio?: string | null,
  sinal?: AbortSignal,
): Promise<ResultadoDePedido> {
  let r: Response;
  try {
    r = await fetch(`/api/canais/${encodeURIComponent(canalId)}/play`, {
      method: "POST",
      signal: sinal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(
        reresolucao ? { reresolucao: true } : concessaoAnuncio ? { concessao: concessaoAnuncio } : {},
      ),
    });
  } catch {
    return { ok: false, definitivo: false };
  }

  if (!r.ok) {
    const corpo = (await r.json().catch(() => ({}))) as { erro?: string; nivelExigido?: string };
    // Mensagens genéricas, por decisão de exposição: o usuário comum não recebe
    // motivo técnico, host, provider nem status do provedor.
    if (r.status === 401) {
      return { ok: false, definitivo: true, mensagem: "Faça login para assistir." };
    }
    if (r.status === 403) {
      return {
        ok: false,
        definitivo: true,
        mensagem: corpo.nivelExigido
          ? `Este canal faz parte do plano ${corpo.nivelExigido}.`
          : "Seu plano não inclui este canal.",
      };
    }
    if (r.status === 404) {
      return { ok: false, definitivo: true, mensagem: "Canal indisponível no momento." };
    }
    // 429 e 5xx: passageiros. O controle tenta de novo, sob o teto.
    return { ok: false, definitivo: false };
  }

  // Só a `streamUrl` sai do servidor. Nada é guardado além do estado do player.
  const corpo = (await r.json()) as { streamUrl?: unknown };
  if (typeof corpo.streamUrl !== "string" || !corpo.streamUrl) {
    return { ok: false, definitivo: false };
  }
  return { ok: true, streamUrl: corpo.streamUrl };
}

export function PlayerDeCanal({
  canal,
  onFechar,
  concessaoAnuncio,
  inline = false,
  acoesRef,
}: {
  canal: ItemDeCanal;
  onFechar?: () => void;
  concessaoAnuncio?: string | null;
  inline?: boolean;
  acoesRef?: MutableRefObject<AcoesDoPlayerDeCanal | null>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [estado, setEstado] = useState<Estado>({ fase: "pedindo" });
  const [tentativa, setTentativa] = useState(0);

  // Estado dos controles (só reflete o `<video>`/`hls.js`; sem lógica de VOD).
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [alturasDosNiveis, setAlturasDosNiveis] = useState<(number | null)[]>([]);
  const [nivelAtual, setNivelAtual] = useState(-1);
  const [castDisponivel, setCastDisponivel] = useState(false);
  const [transmitindo, setTransmitindo] = useState(false);
  const [controlesVisiveis, setControlesVisiveis] = useState(true);
  const [atualizando, setAtualizando] = useState(false);
  /** Altura do vídeo em uso, só quando o player a reporta (selo `1080p`). */
  const [alturaEmUso, setAlturaEmUso] = useState<number | null>(null);
  const [logoFalhou, setLogoFalhou] = useState(false);

  /**
   * Como trocar a fonte, publicado pelo efeito do HLS. Vive numa referência
   * porque o controle é criado uma vez e precisa alcançar a instância de
   * `hls.js` do outro efeito. Enquanto ela não existe, a primeira URL fica em
   * `pendente` e é aplicada assim que o player nasce.
   */
  const trocarRef = useRef<((url: string) => void) | null>(null);
  const pendenteRef = useRef<string | null>(null);
  /** O controle vive numa ref para o efeito do HLS alcançar `aoErroDeReproducao`. */
  const controleRef = useRef<ControleDeCanal | null>(null);
  /** A instância de hls.js, para o menu de qualidade. `null` no HLS nativo. */
  const hlsRef = useRef<{ currentLevel: number } | null>(null);
  const playingRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const atualizandoRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);

  function aplicar(url: string) {
    if (trocarRef.current) trocarRef.current(url);
    else pendenteRef.current = url;
  }

  // ── Concessão e re-resolução em erro ────────────────────────────────────────
  useEffect(() => {
    setEstado({ fase: "pedindo" });
    trocarRef.current = null;
    pendenteRef.current = null;

    // Cancela de fato o `/play` em voo quando o canal troca (o controle já
    // descartaria a resposta; abortar libera a conexão na hora).
    const abortador = new AbortController();
    const controle = criarControleDeCanal({
      canalId: canal.id,
      pedir: (canalId, reresolucao) =>
        pedirConcessao(canalId, reresolucao, reresolucao ? null : concessaoAnuncio, abortador.signal),
      trocarFonte: (url) => {
        aplicar(url);
        setEstado((anterior) =>
          anterior.fase === "tocando" ? anterior : { fase: "tocando", primeiraUrl: url },
        );
      },
      // Esgotado o teto de re-resoluções, oferece o "tentar de novo" manual, que
      // recria o controle e zera a contagem.
      aoPerder: (mensagem) => setEstado({ fase: "erro", mensagem, podeTentarDeNovo: true }),
      agenda: {
        agendar: (fn, ms) => window.setTimeout(fn, ms),
        cancelar: (id) => window.clearTimeout(id),
      },
    });
    controleRef.current = controle;

    const abertura = window.setTimeout(() => void controle.iniciar(), ATRASO_DE_ABERTURA_MS);
    return () => {
      window.clearTimeout(abertura);
      controle.parar();
      abortador.abort();
      controleRef.current = null;
    };
    // `tentativa` recria o controle inteiro — é o botão "tentar de novo".
  }, [canal.id, concessaoAnuncio, tentativa]);

  // ── HLS ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (estado.fase !== "tocando") return;
    const video = videoRef.current;
    if (!video) return;

    let cancelado = false;
    let destruir = () => {};

    // hls.js (MSE) primeiro; HLS nativo só onde não há MSE (iOS sem Managed
    // Media Source). A ordem importa: a WebView do Android anuncia HLS nativo,
    // mas ele roda no MediaPlayer do sistema, que escolhe o parser pela extensão
    // do segmento — e os segmentos das CDNs de canais chegam como MPEG-TS com
    // extensão que não é `.ts`. O MediaPlayer recusa; o hls.js olha o conteúdo e
    // toca. O CDN responde CORS, então o hls.js pode buscá-lo direto.
    const usarNativo = () => {
      // HLS nativo: sem hls.js, sem menu de qualidade; o erro do elemento dispara
      // a mesma re-resolução controlada.
      hlsRef.current = null;
      setAlturasDosNiveis([]);
      const aoErroNativo = () => controleRef.current?.aoErroDeReproducao();
      const aoMudarDimensao = () => setAlturaEmUso(video.videoHeight || null);
      video.addEventListener("error", aoErroNativo);
      video.addEventListener("loadedmetadata", aoMudarDimensao);
      video.addEventListener("resize", aoMudarDimensao);
      trocarRef.current = (url) => {
        video.src = url;
        void video.play().catch(() => {});
      };
      trocarRef.current(pendenteRef.current ?? estado.primeiraUrl);
      pendenteRef.current = null;
      destruir = () => {
        video.removeEventListener("error", aoErroNativo);
        video.removeEventListener("loadedmetadata", aoMudarDimensao);
        video.removeEventListener("resize", aoMudarDimensao);
      };
    };

    void import("hls.js").then(({ default: Hls }) => {
      if (cancelado) return;
      if (!Hls.isSupported()) {
        usarNativo();
        return;
      }
      const hls = new Hls({
        // Live: começar perto da borda, e não no início do buffer disponível.
        liveSyncDurationCount: 3,
        enableWorker: true,
      });
      hlsRef.current = hls as unknown as { currentLevel: number };
      hls.attachMedia(video);

      // Em Auto, `currentLevel` devolve o nível real em uso; `autoLevelEnabled`
      // é o que diz "o usuário deixou no automático" — é isso que o menu marca.
      const nivelSelecionado = () => (hls.autoLevelEnabled ? -1 : hls.currentLevel);
      const publicarNiveis = () => {
        setAlturasDosNiveis(hls.levels.map((l) => (typeof l.height === "number" ? l.height : null)));
        setNivelAtual(nivelSelecionado());
      };
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        publicarNiveis();
        void video.play().catch(() => {});
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, dados) => {
        setNivelAtual(nivelSelecionado());
        const altura = hls.levels[dados.level]?.height;
        setAlturaEmUso(typeof altura === "number" && altura > 0 ? altura : null);
      });
      hls.on(Hls.Events.ERROR, (_e, dados) => {
        if (!dados.fatal) return;
        // Erro fatal num canal ao vivo costuma ser a fonte caindo/rotacionando.
        // Re-resolve de forma controlada (teto/single-flight no controle).
        controleRef.current?.aoErroDeReproducao();
      });

      // **Aqui** o player migra de verdade. `loadSource` **não preserva a
      // posição**; por isso ela é restaurada à mão, pelo buffer: se o ponto
      // anterior ainda está bufferizado, volta-se a ele; senão, fica na borda.
      trocarRef.current = (url) => {
        const antes = video.currentTime;
        const tocava = !video.paused;

        const restaurar = () => {
          for (let i = 0; i < video.buffered.length; i++) {
            if (antes >= video.buffered.start(i) && antes <= video.buffered.end(i)) {
              if (Math.abs(video.currentTime - antes) > 0.1) video.currentTime = antes;
              break;
            }
          }
          if (tocava) void video.play().catch(() => {});
        };

        hls.loadSource(url);
        hls.once(Hls.Events.FRAG_BUFFERED, restaurar);
        hls.once(Hls.Events.MANIFEST_PARSED, () => setTimeout(restaurar, 0));
      };
      trocarRef.current(pendenteRef.current ?? estado.primeiraUrl);
      pendenteRef.current = null;

      destruir = () => hls.destroy();
    });

    return () => {
      cancelado = true;
      trocarRef.current = null;
      hlsRef.current = null;
      destruir();
      video.removeAttribute("src");
      video.load();
    };
    // Só a entrada em "tocando" recria o player. As renovações seguintes passam
    // por `trocarRef`, sem remontar a instância.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado.fase]);

  // ── Estado dos controles: espelha o <video> ─────────────────────────────────
  useEffect(() => {
    if (estado.fase !== "tocando") return;
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => { setPlaying(true); playingRef.current = true; };
    const onPause = () => { setPlaying(false); playingRef.current = false; setControlesVisiveis(true); };
    const onVol = () => { setMuted(video.muted); setVolume(video.muted ? 0 : video.volume); };
    setMuted(video.muted);
    setVolume(video.muted ? 0 : video.volume);
    setPlaying(!video.paused);
    playingRef.current = !video.paused;

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVol);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVol);
    };
  }, [estado.fase]);

  // ── Fullscreen ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ── Sair da tela cheia sem fechar o canal ───────────────────────────────────
  // Dois caminhos, porque no Electron o Esc real é consumido pelo processo
  // principal (`before-input-event`), que só desfaz a tela cheia da JANELA:
  //  1. Esc que chega à página → `exitFullscreen()`;
  //  2. a janela deixou de ocupar a tela enquanto o player ainda é o
  //     `fullscreenElement` → `exitFullscreen()` também.
  // O segundo só age depois de a tela cheia ter sido de fato atingida, para não
  // disparar durante a transição de entrada.
  useEffect(() => {
    const noElemento = () => !!rootRef.current && document.fullscreenElement === rootRef.current;
    const janelaCheia = () =>
      janelaOcupaATela(
        { largura: window.innerWidth, altura: window.innerHeight },
        { largura: window.screen.width, altura: window.screen.height },
      );
    const sair = () => { void document.exitFullscreen().catch(() => {}); };
    let atingiuTelaCheia = false;

    const aoTeclar = (e: KeyboardEvent) => {
      if (!ehTeclaDeSairDaTelaCheia(e.key) || !noElemento()) return;
      e.preventDefault();
      e.stopPropagation();
      sair();
    };
    const aoMudarTelaCheia = () => { atingiuTelaCheia = noElemento() && janelaCheia(); };
    const aoRedimensionar = () => {
      if (!noElemento()) return;
      if (janelaCheia()) atingiuTelaCheia = true;
      else if (atingiuTelaCheia) { atingiuTelaCheia = false; sair(); }
    };

    window.addEventListener("keydown", aoTeclar, true);
    document.addEventListener("fullscreenchange", aoMudarTelaCheia);
    window.addEventListener("resize", aoRedimensionar);
    return () => {
      window.removeEventListener("keydown", aoTeclar, true);
      document.removeEventListener("fullscreenchange", aoMudarTelaCheia);
      window.removeEventListener("resize", aoRedimensionar);
    };
  }, []);

  // ── Cast (Remote Playback): só habilita se o aparelho suportar ──────────────
  useEffect(() => {
    if (estado.fase !== "tocando") return;
    const video = videoRef.current;
    const remote = remoteDe(video);
    if (!video || !remote) { setCastDisponivel(false); return; }

    let watchId: number | null = null;
    const onConn = () => setTransmitindo(remote.state === "connected" || remote.state === "connecting");
    remote.addEventListener?.("connect", onConn);
    remote.addEventListener?.("connecting", onConn);
    remote.addEventListener?.("disconnect", onConn);
    remote.watchAvailability?.((disp) => setCastDisponivel(disp))
      .then((id) => { watchId = id; })
      .catch(() => setCastDisponivel(false));

    return () => {
      remote.removeEventListener?.("connect", onConn);
      remote.removeEventListener?.("connecting", onConn);
      remote.removeEventListener?.("disconnect", onConn);
      if (watchId !== null) remote.cancelWatchAvailability?.(watchId).catch(() => {});
    };
  }, [estado.fase]);

  // ── Watchdog de stall: recupera stalls silenciosos (sem erro fatal) ─────────
  // Se a reprodução não avança por ~7s e o vídeo não está pausado, dispara a
  // MESMA re-resolução. O single-flight e o teto de 3/60s vivem no controle.
  useEffect(() => {
    if (estado.fase !== "tocando") return;
    const video = videoRef.current;
    if (!video) return;

    const wd = criarWatchdogDeStall();
    const agora = () => Date.now();
    wd.definirPausado(video.paused, agora());
    wd.progrediu(video.currentTime, agora());

    const onPause = () => wd.definirPausado(true, agora());
    const onPlay = () => wd.definirPausado(false, agora());
    video.addEventListener("pause", onPause);
    video.addEventListener("play", onPlay);

    const id = window.setInterval(() => {
      const t = agora();
      wd.progrediu(video.currentTime, t);
      if (wd.deveReresolver(t)) controleRef.current?.aoErroDeReproducao();
    }, 1000);

    return () => {
      window.clearInterval(id);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("play", onPlay);
    };
  }, [estado.fase]);

  // ── BACK / ESC fecham (só no modo modal) ────────────────────────────────────
  useEffect(() => {
    if (inline) return;
    const aoTeclar = (e: KeyboardEvent) => {
      // Em tela cheia, ESC sai da tela cheia (comportamento nativo); só fecha o
      // player quando não está em fullscreen.
      if ((e.key === "Escape" && !document.fullscreenElement) || e.key === "Backspace") onFechar?.();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [onFechar, inline]);

  useEffect(() => () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
  }, []);

  const mostrarControles = useCallback(() => {
    setControlesVisiveis(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (playingRef.current) setControlesVisiveis(false);
    }, 3000);
  }, []);

  // ── Ações dos controles ─────────────────────────────────────────────────────
  const alternarPlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const alternarMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 1;
  }, []);

  const ajustarVolume = useCallback((valor: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = valor;
    v.muted = valor === 0;
  }, []);

  const alternarFullscreen = useCallback(() => {
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => {}); return; }
    void rootRef.current?.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    if (!acoesRef) return;
    acoesRef.current = { alternarTelaCheia: alternarFullscreen };
    return () => {
      acoesRef.current = null;
    };
  }, [acoesRef, alternarFullscreen]);

  const selecionarQualidade = useCallback((indice: number) => {
    if (hlsRef.current) hlsRef.current.currentLevel = indice;
    setNivelAtual(indice);
  }, []);

  const transmitir = useCallback(() => {
    remoteDe(videoRef.current)?.prompt?.().catch(() => {});
  }, []);

  // Atualizar canal: reusa a MESMA re-resolução controlada (single-flight + teto
  // vivem no controle). Não recarrega página/catálogo/sessão. Impede dois
  // refreshes simultâneos e mostra carregamento por uma janela curta.
  const atualizarCanal = useCallback(() => {
    if (atualizandoRef.current) return;
    atualizandoRef.current = true;
    setAtualizando(true);
    controleRef.current?.aoErroDeReproducao();
    if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      atualizandoRef.current = false;
      setAtualizando(false);
    }, 5000);
  }, []);

  const area = (
    <div
      className={inline ? "relative h-full w-full" : "relative flex-1"}
      onPointerMove={mostrarControles}
      onPointerDown={mostrarControles}
    >
      <video
        ref={videoRef}
        className="h-full w-full bg-black object-contain"
        playsInline
        autoPlay
        // Controles próprios (PlayerControls); nada de `controls` nativo.
        // Canal ao vivo não tem pôster próprio e não retoma de lugar nenhum.
        preload="none"
        // A WebView do Android desenha um ícone cinza de "play" em <video> sem
        // pôster até o primeiro quadro; um pixel transparente o esconde.
        poster="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        onClick={alternarPlay}
        onDoubleClick={alternarFullscreen}
      />

      {/* Topo: logo real do canal à esquerda; AO VIVO + resolução à direita. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-black/60 to-transparent px-4 pt-4 pb-10 md:px-6 md:pt-5">
        <span className="flex h-9 min-w-0 items-center md:h-11">
          {canal.logoUrl && !logoFalhou && (
            // Logo de terceiro, tamanho imprevisível: `<img>` com `object-contain`.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={canal.logoUrl}
              alt={canal.nome}
              onError={() => setLogoFalhou(true)}
              className="max-h-full max-w-[7.5rem] object-contain opacity-85 drop-shadow-[0_2px_6px_rgba(0,0,0,0.7)] md:max-w-[9rem]"
            />
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-md bg-live-accent px-2.5 py-1 text-[11px] font-bold leading-none tracking-wide text-white shadow-[0_0_14px_rgba(242,13,36,0.45)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
            AO VIVO
          </span>
          {estado.fase === "tocando" && seloDeResolucao(alturaEmUso) && (
            <span className="rounded-md border border-white/15 bg-black/55 px-2 py-1 text-[11px] font-semibold leading-none text-white backdrop-blur-md">
              {seloDeResolucao(alturaEmUso)}
            </span>
          )}
        </span>
      </div>

      {estado.fase === "tocando" && (
        <PlayerControls
          playing={playing}
          muted={muted}
          volume={volume}
          fullscreen={fullscreen}
          qualidades={opcoesDeQualidade(alturasDosNiveis)}
          qualidadeSelecionada={nivelAtual}
          castDisponivel={castDisponivel}
          transmitindo={transmitindo}
          visivel={controlesVisiveis || !playing}
          atualizando={atualizando}
          onPlayPause={alternarPlay}
          onToggleMute={alternarMute}
          onVolume={ajustarVolume}
          onToggleFullscreen={alternarFullscreen}
          onSelectQualidade={selecionarQualidade}
          onCast={transmitir}
          onRefresh={atualizarCanal}
        />
      )}

      {estado.fase === "pedindo" && (
        <div className="absolute inset-0 grid place-items-center bg-black/80">
          <div className="flex flex-col items-center gap-3">
            <span className="h-9 w-9 animate-spin rounded-full border-2 border-live-line border-t-live-accent" />
            <span className="text-sm text-live-muted">Conectando…</span>
          </div>
        </div>
      )}

      {estado.fase === "erro" && (
        <div className="absolute inset-0 grid place-items-center bg-black/90 px-6">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <p className="text-sm text-zinc-300">{estado.mensagem}</p>
            <div className="flex gap-2">
              {estado.podeTentarDeNovo && (
                <button
                  type="button"
                  onClick={() => setTentativa((n) => n + 1)}
                  className="rounded-lg bg-live-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-live-glow focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                >
                  Tentar de novo
                </button>
              )}
              {!inline && (
                <button
                  type="button"
                  onClick={() => onFechar?.()}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                >
                  Voltar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (inline) {
    return (
      <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-black">
        {area}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => onFechar?.()}
          className="rounded-lg p-2 text-zinc-300 transition hover:bg-zinc-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          aria-label="Fechar"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
        <span className="truncate text-sm font-semibold text-white">{canal.nome}</span>
      </div>
      {area}
    </div>
  );
}
