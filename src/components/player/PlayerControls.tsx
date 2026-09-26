"use client";

import { useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize2, Settings2, Check, Cast, RotateCw } from "lucide-react";
import type { OpcaoDeQualidade } from "@/lib/canais/playerControles";

/**
 * Camada **presentacional** dos controles de player.
 *
 * Sem `<video>`, sem `hls.js`, sem Remote Playback: recebe estado e callbacks e
 * desenha a barra com a identidade visual do `CustomPlayer` (mesmo `btnCls`,
 * mesmo acento `#E50914`, mesmo popup de qualidade). Existe para o player de
 * canal ganhar a mesma experiência de controles sem tocar no `CustomPlayer`.
 *
 * O que **não** existe aqui, de propósito, no modo live: seek/linha do tempo,
 * -10s/+10s, resume, próximo episódio, dub/leg. Ao vivo não tem conteúdo gravado
 * para navegar — só o presente. `Atualizar canal` reusa a re-resolução já
 * existente no motor (passada por `onRefresh`), sem segunda máquina de retry.
 */

const btnCls =
  "flex-shrink-0 w-10 h-10 md:w-12 md:h-12 rounded-full flex items-center justify-center transition-all duration-200 bg-white/10 text-white hover:bg-white hover:text-black active:bg-white active:text-black";

export interface PlayerControlsProps {
  playing: boolean;
  muted: boolean;
  /** 0–1. */
  volume: number;
  fullscreen: boolean;
  /** Mostra o indicador AO VIVO na barra. */
  isLive?: boolean;
  /**
   * Opções de qualidade já prontas (ver `opcoesDeQualidade`). **Vazio esconde o
   * menu** — é assim que "qualidade só se houver variantes reais" é respeitado.
   */
  qualidades?: OpcaoDeQualidade[];
  /** Índice selecionado (-1 = Auto), casando com `OpcaoDeQualidade.indice`. */
  qualidadeSelecionada?: number;
  /** Só habilita o botão de cast quando a capacidade existe (feature-detect no pai). */
  castDisponivel?: boolean;
  transmitindo?: boolean;
  /** Controla o fade da barra (auto-hide gerido pelo pai). */
  visivel?: boolean;
  /** Em andamento uma atualização/re-resolução manual (spinner + desabilita). */
  atualizando?: boolean;

  onPlayPause: () => void;
  onToggleMute: () => void;
  onVolume: (v: number) => void;
  onToggleFullscreen: () => void;
  onSelectQualidade?: (indice: number) => void;
  onCast?: () => void;
  /** Atualizar canal: re-resolve o canal atual pelo mesmo mecanismo do motor. */
  onRefresh?: () => void;
}

export function PlayerControls({
  playing,
  muted,
  volume,
  fullscreen,
  isLive = false,
  qualidades = [],
  qualidadeSelecionada = -1,
  castDisponivel = false,
  transmitindo = false,
  visivel = true,
  atualizando = false,
  onPlayPause,
  onToggleMute,
  onVolume,
  onToggleFullscreen,
  onSelectQualidade,
  onCast,
  onRefresh,
}: PlayerControlsProps) {
  const [mostrarQualidade, setMostrarQualidade] = useState(false);
  const temMenuDeQualidade = qualidades.length > 0;

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 px-3 pt-10 pb-2 bg-gradient-to-t from-black/80 via-black/30 to-transparent transition-opacity duration-300 md:px-8 md:pb-4 ${
        visivel ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="pointer-events-auto flex items-center justify-between">
        {/* Esquerda: AO VIVO + volume */}
        <div className="flex items-center gap-2 md:gap-3">
          {isLive && (
            <span className="flex items-center gap-1.5 rounded bg-[#E50914] px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
              AO VIVO
            </span>
          )}
          <div className="flex items-center gap-1 group/vol">
            <button
              type="button"
              title={muted || volume === 0 ? "Ativar som" : "Silenciar"}
              aria-label={muted || volume === 0 ? "Ativar som" : "Silenciar"}
              className={btnCls}
              onClick={onToggleMute}
            >
              {muted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              aria-label="Volume"
              className="w-16 cursor-pointer accent-[#E50914] md:w-0 md:overflow-hidden md:transition-all md:duration-300 md:group-hover/vol:w-20"
              onChange={(e) => onVolume(parseFloat(e.target.value))}
            />
          </div>
        </div>

        {/* Centro: play/pause */}
        <button
          type="button"
          title={playing ? "Pausar" : "Reproduzir"}
          aria-label={playing ? "Pausar" : "Reproduzir"}
          className="flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center transition-all duration-200 bg-white/15 text-white hover:bg-white hover:text-black hover:scale-105 active:scale-95"
          onClick={onPlayPause}
        >
          {playing ? (
            <Pause className="w-5 h-5 md:w-6 md:h-6" fill="currentColor" strokeWidth={0} />
          ) : (
            <Play className="w-5 h-5 md:w-6 md:h-6 ml-0.5" fill="currentColor" strokeWidth={0} />
          )}
        </button>

        {/* Direita: qualidade + atualizar + cast + tela cheia */}
        <div className="flex items-center gap-1 md:gap-1.5">
          {temMenuDeQualidade && (
            <div className="relative">
              <button
                type="button"
                title="Qualidade"
                aria-label="Qualidade"
                className={`${btnCls}${mostrarQualidade ? " !bg-white !text-black" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setMostrarQualidade((v) => !v);
                }}
              >
                <Settings2 className="w-5 h-5" />
              </button>

              {mostrarQualidade && (
                <div
                  className="absolute right-0 bottom-full mb-2 w-[min(16rem,calc(100vw-1rem))] max-h-[60dvh] overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-zinc-950 p-2 text-white shadow-2xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/45">
                    Qualidade
                  </p>
                  {qualidades.map((opcao) => (
                    <button
                      type="button"
                      key={`q-${opcao.indice}`}
                      className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                        qualidadeSelecionada === opcao.indice
                          ? "bg-white/15 text-white"
                          : "text-white/70 hover:bg-white/10 hover:text-white"
                      }`}
                      onClick={() => {
                        onSelectQualidade?.(opcao.indice);
                        setMostrarQualidade(false);
                      }}
                    >
                      <span>{opcao.rotulo}</span>
                      {qualidadeSelecionada === opcao.indice && (
                        <Check className="h-4 w-4 text-[#E50914]" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {onRefresh && (
            <button
              type="button"
              title="Atualizar canal"
              aria-label="Atualizar canal"
              disabled={atualizando}
              className={`${btnCls} disabled:opacity-60`}
              onClick={onRefresh}
            >
              <RotateCw className={`w-5 h-5${atualizando ? " animate-spin" : ""}`} />
            </button>
          )}

          {castDisponivel && (
            <button
              type="button"
              title={transmitindo ? "Parar transmissão" : "Transmitir"}
              aria-label={transmitindo ? "Parar transmissão" : "Transmitir"}
              className={`${btnCls}${transmitindo ? " !bg-[#E50914] !text-white hover:!bg-red-600" : ""}`}
              onClick={onCast}
            >
              <Cast className="w-5 h-5" />
            </button>
          )}

          <button
            type="button"
            title={fullscreen ? "Sair da tela cheia" : "Tela cheia"}
            aria-label={fullscreen ? "Sair da tela cheia" : "Tela cheia"}
            className={btnCls}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
