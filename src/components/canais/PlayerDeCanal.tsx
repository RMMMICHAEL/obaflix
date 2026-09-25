"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ItemDeCanal } from "@/lib/canais/catalogo";
import {
  criarControleDeCanal,
  type ControleDeCanal,
  type ResultadoDePedido,
} from "@/lib/canais/handoff";
import { PlayerControls } from "@/components/player/PlayerControls";
import { opcoesDeQualidade } from "@/lib/canais/playerControles";
import { criarWatchdogDeStall } from "@/lib/canais/watchdogDeStall";

/**
 * Player de canal ao vivo.
 *
 * Próprio, e não o `CustomPlayer` de filmes/séries, de propósito. Aquele carrega
 * failover de fontes, extração, legendas, retomada e anúncios — e canal ao vivo
 * não precisa de nada disso: precisa de uma URL de manifesto, sem linha do tempo
 * e sem retomada.
 *
 * ## Identidade visual dos controles
 *
 * A **experiência** de controles vem do `PlayerControls` (camada presentacional
 * compartilhável, mesma identidade do `CustomPlayer`), mas o **motor** continua
 * aqui e é o de live: só play/pause, volume/mute, tela cheia, qualidade quando
 * o `hls.js` oferece variantes reais e cast quando o aparelho suporta. Sem seek,
 * sem resume, sem próximo episódio, sem dub/leg — nada que não faça sentido ao
 * vivo.
 *
 * ## O que este componente nunca vê
 *
 * O provider, o host do CDN, o Referer. Recebe do `/play` só a `streamUrl` e é
 * só o que existe no estado. Nada é guardado em `localStorage`.
 *
 * ## A migração entre concessões é real
 *
 * O protocolo de re-resolução em erro vive em `@/lib/canais/handoff`, testado à
 * parte. Aqui `trocarFonte` chama `hls.loadSource(url)` — ou troca `video.src` no
 * HLS nativo — para o player **passar a buscar** pela concessão nova.
 */

type Estado =
  | { fase: "pedindo" }
  | { fase: "tocando"; primeiraUrl: string }
  | { fase: "erro"; mensagem: string; podeTentarDeNovo: boolean };

class ErroDeCanal extends Error {
  constructor(mensagem: string, readonly definitivo: boolean) {
    super(mensagem);
  }
}

/** Acesso opcional ao Remote Playback (cast nativo do navegador/WebView). */
interface RemotePlaybackLike {
  state?: string;
  watchAvailability?: (cb: (available: boolean) => void) => Promise<number>;
  cancelWatchAvailability?: (id: number) => Promise<void>;
  prompt?: () => Promise<void>;
  addEventListener?: (tipo: string, cb: () => void) => void;
  removeEventListener?: (tipo: string, cb: () => void) => void;
}
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
): Promise<ResultadoDePedido> {
  let r: Response;
  try {
    r = await fetch(`/api/canais/${encodeURIComponent(canalId)}/play`, {
      method: "POST",
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
    // Mensagens genéricas, por decisão de exposição: o usuário comum não
    // recebe motivo técnico, host, provider nem status do provedor.
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

export function PlayerDeCanal({ canal, onFechar, concessaoAnuncio }: { canal: ItemDeCanal; onFechar: () => void; concessaoAnuncio?: string | null }) {
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

  function aplicar(url: string) {
    if (trocarRef.current) trocarRef.current(url);
    else pendenteRef.current = url;
  }

  // ── Concessão e re-resolução em erro ────────────────────────────────────────
  useEffect(() => {
    setEstado({ fase: "pedindo" });
    trocarRef.current = null;
    pendenteRef.current = null;

    const controle = criarControleDeCanal({
      canalId: canal.id,
      pedir: (canalId, reresolucao) =>
        pedirConcessao(canalId, reresolucao, reresolucao ? null : concessaoAnuncio),
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

    void controle.iniciar();
    return () => {
      controle.parar();
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

    // Safari e a WebView do Android tocam HLS nativamente; aí o hls.js só
    // acrescentaria uma camada de buffer sobre algo que já funciona.
    if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
      // HLS nativo (Safari, WebView do Android): sem hls.js, sem menu de
      // qualidade; o erro do elemento dispara a mesma re-resolução controlada.
      hlsRef.current = null;
      setAlturasDosNiveis([]);
      const aoErroNativo = () => controleRef.current?.aoErroDeReproducao();
      video.addEventListener("error", aoErroNativo);
      trocarRef.current = (url) => {
        video.src = url;
        void video.play().catch(() => {});
      };
      trocarRef.current(pendenteRef.current ?? estado.primeiraUrl);
      pendenteRef.current = null;
      destruir = () => video.removeEventListener("error", aoErroNativo);
    } else {
      void import("hls.js").then(({ default: Hls }) => {
        if (cancelado || !Hls.isSupported()) return;
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
          // Só as alturas — o menu decide sozinho se aparece (variantes > 1).
          setAlturasDosNiveis(hls.levels.map((l) => (typeof l.height === "number" ? l.height : null)));
          setNivelAtual(nivelSelecionado());
        };
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          publicarNiveis();
          void video.play().catch(() => {});
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, () => setNivelAtual(nivelSelecionado()));
        hls.on(Hls.Events.ERROR, (_e, dados) => {
          if (!dados.fatal) return;
          // Erro fatal num canal ao vivo costuma ser a fonte do provider caindo
          // ou rotacionando. Re-resolve de forma controlada: o controle pede uma
          // `streamUrl` nova ao `/play` e a troca; o teto por janela vive nele e,
          // esgotado, chama `aoPerder`. Sem repetição infinita.
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
    }

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
  // O HAR da homologação provou stalls de 15–29s em que o hls policiava o
  // manifesto sem receber segmento e NÃO emitia erro fatal — então o gatilho do
  // #46 (fatal) demorava, gerando telas pretas longas. Aqui: se a reprodução não
  // avança por ~7s e o vídeo não está pausado, dispara a MESMA re-resolução. O
  // single-flight e o teto de 3/60s vivem no controle (não duplicamos nada).
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

    // Poll do currentTime: robusto (não depende de `timeupdate`/`waiting`/
    // `stalled` dispararem durante o congelamento — a ausência de avanço basta).
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

  // ── BACK / ESC fecham ──────────────────────────────────────────────────────
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      // Em tela cheia, ESC sai da tela cheia (comportamento nativo); só fecha o
      // player quando não está em fullscreen.
      if ((e.key === "Escape" && !document.fullscreenElement) || e.key === "Backspace") onFechar();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [onFechar]);

  useEffect(() => () => { if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current); }, []);

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

  const selecionarQualidade = useCallback((indice: number) => {
    if (hlsRef.current) hlsRef.current.currentLevel = indice;
    setNivelAtual(indice);
  }, []);

  const transmitir = useCallback(() => {
    remoteDe(videoRef.current)?.prompt?.().catch(() => {});
  }, []);

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onFechar}
          className="rounded-lg p-2 text-zinc-300 transition hover:bg-zinc-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          aria-label="Fechar"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
        <span className="truncate text-sm font-semibold text-white">{canal.nome}</span>
        <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
          AO VIVO
        </span>
      </div>

      <div
        className="relative flex-1"
        onPointerMove={mostrarControles}
        onPointerDown={mostrarControles}
      >
        <video
          ref={videoRef}
          className="h-full w-full bg-black"
          playsInline
          autoPlay
          // Controles próprios (PlayerControls); nada de `controls` nativo.
          // Canal ao vivo não tem pôster próprio e não retoma de lugar nenhum.
          preload="none"
          onClick={alternarPlay}
        />

        {estado.fase === "tocando" && (
          <PlayerControls
            isLive
            playing={playing}
            muted={muted}
            volume={volume}
            fullscreen={fullscreen}
            qualidades={opcoesDeQualidade(alturasDosNiveis)}
            qualidadeSelecionada={nivelAtual}
            castDisponivel={castDisponivel}
            transmitindo={transmitindo}
            visivel={controlesVisiveis || !playing}
            onPlayPause={alternarPlay}
            onToggleMute={alternarMute}
            onVolume={ajustarVolume}
            onToggleFullscreen={alternarFullscreen}
            onSelectQualidade={selecionarQualidade}
            onCast={transmitir}
          />
        )}

        {estado.fase === "pedindo" && (
          <div className="absolute inset-0 grid place-items-center bg-black/80">
            <div className="flex flex-col items-center gap-3">
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-red-600" />
              <span className="text-sm text-zinc-400">Conectando…</span>
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
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
                  >
                    Tentar de novo
                  </button>
                )}
                <button
                  type="button"
                  onClick={onFechar}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                >
                  Voltar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
