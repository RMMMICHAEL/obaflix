/**
 * Diagnóstico por etapa do pipeline HLS.
 *
 * Motivo de existir: até aqui, "extract respondeu 200" era tratado como player
 * funcionando. Não é. O pipeline tem seis estágios, e a falha mais comum
 * acontece depois da extração — o CDN devolve 403 no init segment porque exige
 * o Referer do provedor, que o navegador não pode forjar. Sem separar os
 * estágios, quatro provedores diferentes pareciam quebrados pelo mesmo motivo
 * invisível.
 *
 * Sucesso só é declarado quando o player exibe o primeiro frame — ou seja,
 * depois de carregar o init segment e os primeiros segmentos de mídia.
 */

export type EtapaPlayer =
  | "EXTRACT_FAILED"
  | "MASTER_FAILED"
  | "PLAYLIST_FAILED"
  | "INIT_SEGMENT_403"
  | "MEDIA_SEGMENT_403"
  | "TLS_FAILED"
  | "PLAYER_DECODE_FAILED"
  | "TIMEOUT"
  | "OK_PLAYBACK";

/** Estágio numerado, para ordenar a matriz Player → etapa. */
export const ORDEM_ETAPA: Record<EtapaPlayer, number> = {
  EXTRACT_FAILED: 1,
  MASTER_FAILED: 2,
  PLAYLIST_FAILED: 3,
  INIT_SEGMENT_403: 4,
  MEDIA_SEGMENT_403: 5,
  PLAYER_DECODE_FAILED: 6,
  TLS_FAILED: 0,
  TIMEOUT: 0,
  OK_PLAYBACK: 7,
};

export function hostDe(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "-";
  }
}

/** Só o nome do arquivo, sem query — evita vazar token/assinatura no log. */
function arquivoDe(url: string): string {
  try {
    const p = new URL(url).pathname;
    return p.substring(p.lastIndexOf("/") + 1) || "/";
  } catch {
    return "-";
  }
}

type Entrada = {
  url?: string;
  http?: number;
  jwCode?: number | string;
  mensagem?: string;
};

/**
 * Classifica onde o pipeline morreu, combinando o recurso pedido, o status HTTP
 * e o código do JW Player. A ordem importa: o recurso é o sinal mais confiável,
 * porque o mesmo código do JW aparece em estágios diferentes.
 */
export function classificarEtapa({ url = "", http, jwCode, mensagem = "" }: Entrada): EtapaPlayer {
  const arquivo = arquivoDe(url).toLowerCase();
  const texto = String(mensagem).toLowerCase();

  if (/certificate|ssl|tls|handshake/.test(texto)) return "TLS_FAILED";
  if (/timeout|timed out/.test(texto)) return "TIMEOUT";

  const negado = http === 403 || http === 401;

  // init segment: init.mp4 / init.m4s / #EXT-X-MAP
  if (/^init\./.test(arquivo) || /\binit\b/.test(arquivo)) {
    return negado ? "INIT_SEGMENT_403" : "PLAYLIST_FAILED";
  }

  // segmentos de mídia
  if (/\.(m4s|ts|mp4|aac|vtt)$/.test(arquivo)) {
    if (negado) return "MEDIA_SEGMENT_403";
    // Sem erro de rede num segmento, a falha é de decodificação.
    return http && http >= 400 ? "MEDIA_SEGMENT_403" : "PLAYER_DECODE_FAILED";
  }

  // manifestos
  if (/\.m3u8$/.test(arquivo) || /master|playlist/.test(arquivo)) {
    return /master/.test(arquivo) ? "MASTER_FAILED" : "PLAYLIST_FAILED";
  }

  // JW 224003 = "este arquivo de vídeo não pode ser reproduzido"
  if (String(jwCode) === "224003") return "PLAYER_DECODE_FAILED";
  if (http && http >= 400) return "PLAYLIST_FAILED";
  return "PLAYER_DECODE_FAILED";
}

/**
 * Emite uma linha por estágio, em formato fixo e pesquisável.
 * Aparece no console do navegador e no logcat do Android (via onConsoleMessage).
 */
export function logEtapa(
  player: string,
  etapa: EtapaPlayer,
  dados: Entrada & { ms?: number } = {},
): void {
  const partes = [
    `player=${player}`,
    `etapa=${etapa}`,
    `estagio=${ORDEM_ETAPA[etapa]}/7`,
    dados.http !== undefined ? `http=${dados.http}` : null,
    dados.url ? `host=${hostDe(dados.url)}` : null,
    dados.url ? `arquivo=${arquivoDe(dados.url)}` : null,
    dados.jwCode !== undefined ? `jw=${dados.jwCode}` : null,
    dados.ms !== undefined ? `ms=${dados.ms}` : null,
  ].filter(Boolean);

  const linha = `[diag/etapa] ${partes.join(" ")}`;
  if (etapa === "OK_PLAYBACK") console.log(linha);
  else console.warn(linha);
}
