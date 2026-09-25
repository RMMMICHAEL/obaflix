/**
 * Watchdog de stall para canal ao vivo — **lógica pura**, sem DOM, sem timers.
 *
 * Existe porque a análise do HAR da homologação provou stalls **silenciosos**: o
 * `hls.js` fica policiando o manifesto sem receber segmento por ~15–29 s e **não
 * emite erro fatal**, então a re-resolução do #46 (que só arma no fatal) demora a
 * disparar — tela preta longa. O watchdog encurta isso: se a reprodução não
 * avança por ~`limiarMs`, manda re-resolver **pelo mesmo** caminho já testado.
 *
 * O que ele **não** é: uma segunda máquina de retry. Ele só **decide o momento**
 * de chamar `controle.aoErroDeReproducao()` — o single-flight, o teto de 3
 * re-resoluções em 60 s e a proteção contra laço continuam vivendo em
 * `criarControleDeCanal` (intocado). E ele dispara **uma vez por episódio de
 * stall**: só volta a poder disparar depois de a reprodução voltar a avançar.
 *
 * Regras que o mantêm honesto:
 *   - **pausa voluntária nunca dispara** (`definirPausado(true)`);
 *   - **buffering curto normal não dispara** — só a ausência de avanço por
 *     `limiarMs` inteiro conta;
 *   - **qualquer avanço real de `currentTime` reseta** o relógio do stall;
 *   - antes do primeiro avanço (carregando) não dispara — não é stall, é abertura.
 */

export interface WatchdogDeStall {
  /** Reporta o `currentTime` (segundos) observado agora. Avanço real reseta o stall. */
  progrediu(currentTimeSeg: number, agoraMs: number): void;
  /** Estado de pausa. Pausa voluntária nunca dispara; retomar dá carência. */
  definirPausado(pausado: boolean, agoraMs: number): void;
  /**
   * Avalia agora. Retorna `true` **uma única vez por stall** quando: não pausado,
   * já houve reprodução, e não há avanço real de `currentTime` há >= `limiarMs`.
   * Depois de retornar `true`, só volta a poder disparar após um novo avanço.
   */
  deveReresolver(agoraMs: number): boolean;
  /** Só observabilidade/teste: está em stall neste instante? */
  emStall(agoraMs: number): boolean;
}

const LIMIAR_PADRAO_MS = 7000;
/** Um avanço de `currentTime` menor que isto é ruído, não progresso. */
const EPSILON_SEG = 0.02;

export function criarWatchdogDeStall(opts?: { limiarMs?: number }): WatchdogDeStall {
  const limiarMs = opts?.limiarMs ?? LIMIAR_PADRAO_MS;

  let iniciado = false;
  let ultimoCurrentTime = -1;
  let ultimoAvancoMs = 0;
  let pausado = false;
  /** Já disparou para o stall atual? Impede repetir antes da recuperação. */
  let disparado = false;

  return {
    progrediu(currentTimeSeg, agoraMs) {
      if (!Number.isFinite(currentTimeSeg)) return;
      if (!iniciado) {
        iniciado = true;
        ultimoCurrentTime = currentTimeSeg;
        ultimoAvancoMs = agoraMs;
        disparado = false;
        return;
      }
      // Qualquer movimento real (avanço, ou reposição após re-resolução) conta
      // como progresso e reabre o watchdog para um próximo episódio.
      if (Math.abs(currentTimeSeg - ultimoCurrentTime) > EPSILON_SEG) {
        ultimoCurrentTime = currentTimeSeg;
        ultimoAvancoMs = agoraMs;
        disparado = false;
      }
    },

    definirPausado(p, agoraMs) {
      pausado = p;
      if (!p) {
        // Retomar dá carência: não conta o tempo parado como stall.
        ultimoAvancoMs = agoraMs;
        disparado = false;
      }
    },

    deveReresolver(agoraMs) {
      if (pausado || !iniciado || disparado) return false;
      if (agoraMs - ultimoAvancoMs >= limiarMs) {
        disparado = true;
        return true;
      }
      return false;
    },

    emStall(agoraMs) {
      return iniciado && !pausado && agoraMs - ultimoAvancoMs >= limiarMs;
    },
  };
}
