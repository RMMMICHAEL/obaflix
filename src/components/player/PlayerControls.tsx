"use client";

import { useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize2, Settings2, Check, Cast, RotateCw } from "lucide-react";
import type { OpcaoDeQualidade } from "@/lib/canais/playerControles";

/**
 * Camada **presentacional** dos controles de player.
 *
 * Sem `<video>`, sem `hls.js`, sem Remote Playback: recebe estado e callbacks e
 * desenha a barra. Linguagem da tela de Canais ao Vivo: círculos grafite
 * translúcidos, ícones brancos, hover/foco claros e sutis, play/pause
 * ligeiramente maior, acento `live-accent` só em destaque (volume, seleção).
 *
 * O que **não** existe aqui, de propósito, no modo live: seek/linha do tempo,
 * -10s/+10s, resume, próximo episódio, dub/leg. Ao vivo não tem conteúdo gravado
 * para navegar — só o presente. `Atualizar canal` reusa a re-resolução já
 * existente no motor (passada por `onRefresh`), sem segunda máquina de retry.
 */

const btnBase =
  "flex-shrink-0 rounded-full flex items-center justify-center border border-white/10 bg-black/45 text-white backdrop-blur-md transition duration-200 hover:bg-white/15 hover:border-white/25 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80";
const btnCls = `${btnBase} w-10 h-10 md:w-11 md:h-11`;
const btnPrincipalCls = `${btnBase} w-12 h-12 md:w-[52px] md:h-[52px]`;

export interface PlayerControlsProps {
  playing: boolean;
  muted: boolean;
  /** 0–1. */
  volume: number;
  fullscreen: boolean;
  /** Mostra o indicador AO VIVO na barra (quando o pai não mostra o próprio). */
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
  const semSom = muted || volume === 0;

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent px-3 pt-16 pb-3 transition-opacity duration-300 md:px-6 md:pb-5 ${
        visivel ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="pointer-events-auto flex items-center justify-between gap-3">
        {/* Esquerda: play/pause + volume */}
        <div className="flex min-w-0 items-center gap-2 md:gap-3">
          <button
            type="button"
            title={playing ? "Pausar" : "Reproduzir"}
            aria-label={playing ? "Pausar" : "Reproduzir"}
            className={btnPrincipalCls}
            onClick={onPlayPause}
          >
            {playing ? (
              <Pause className="h-5 w-5 md:h-6 md:w-6" fill="currentColor" strokeWidth={0} />
            ) : (
              <Play className="ml-0.5 h-5 w-5 md:h-6 md:w-6" fill="currentColor" strokeWidth={0} />
            )}
          </button>

          <button
            type="button"
            title={semSom ? "Ativar som" : "Silenciar"}
            aria-label={semSom ? "Ativar som" : "Silenciar"}
            className={btnCls}
            onClick={onToggleMute}
          >
            {semSom ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
          {/* Slider só no desktop; no toque o volume é o do aparelho. */}
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={muted ? 0 : volume}
            aria-label="Volume"
            className="hidden w-24 cursor-pointer accent-live-accent md:block"
            onChange={(e) => onVolume(parseFloat(e.target.value))}
          />

          {isLive && (
            <span className="ml-1 flex items-center gap-1.5 rounded-md bg-live-accent px-2 py-1 text-[10px] font-bold leading-none text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden />
              AO VIVO
            </span>
          )}
        </div>

        {/* Direita: qualidade + atualizar + cast + tela cheia */}
        <div className="flex items-center gap-1.5 md:gap-2.5">
          {temMenuDeQualidade && (
            <div className="relative">
              <button
                type="button"
                title="Qualidade"
                aria-label="Qualidade"
                aria-expanded={mostrarQualidade}
                className={`${btnCls}${mostrarQualidade ? " !bg-white/20 !border-white/30" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setMostrarQualidade((v) => !v);
                }}
              >
                <Settings2 className="h-5 w-5" />
              </button>

              {mostrarQualidade && (
                <div
                  className="absolute right-0 bottom-full mb-2 w-[min(16rem,calc(100vw-1rem))] max-h-[60dvh] overflow-y-auto overscroll-contain rounded-2xl border border-live-line bg-live-surface/95 p-2 text-white shadow-2xl backdrop-blur-md"
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
                      {qualidadeSelecionada === opcao.indice && <Check className="h-4 w-4 text-live-accent" />}
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
              <RotateCw className={`h-5 w-5${atualizando ? " animate-spin" : ""}`} />
            </button>
          )}

          {castDisponivel && (
            <button
              type="button"
              title={transmitindo ? "Parar transmissão" : "Transmitir"}
              aria-label={transmitindo ? "Parar transmissão" : "Transmitir"}
              className={`${btnCls}${transmitindo ? " !border-live-accent !bg-live-accent/80" : ""}`}
              onClick={onCast}
            >
              <Cast className="h-5 w-5" />
            </button>
          )}

          <button
            type="button"
            title={fullscreen ? "Sair da tela cheia" : "Tela cheia"}
            aria-label={fullscreen ? "Sair da tela cheia" : "Tela cheia"}
            className={btnCls}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
