// Critérios de recuperação e troca automática de servidor.
//
// Vale igualmente nos três ambientes por construção: Electron e Android carregam
// o mesmo bundle da Vercel e rodam este código: só os *sinais* chegam por
// transportes diferentes (fetch, IPC, bridge). Ver CLAUDE.md.
//
// A regra que domina o desenho é de consumo, não de correção: um episódio custa
// ~468 MB, então cada troca de fonte precisa retomar da posição real. Voltar
// para o começo desperdiça mais banda do que toda a economia da extração nativa.

export type Veredito =
  /** O provedor provou que o arquivo não existe mais. Descarta a fonte já. */
  | "FATAL"
  /** Pode ser passageiro: 5xx, timeout, rede, TLS. Tenta de novo. */
  | "TRANSITORIO"
  /** 403/401 — token ou autorização. Vale uma reextração controlada. */
  | "TOKEN"
  /** Cancelamento normal do HLS ou eco de uma fonte já trocada. */
  | "IGNORAR";

export type Acao = "ignorar" | "retry" | "reextrair" | "failover" | "erro";

export const LIMITES = {
  /** Tentativas de recuperação na mesma fonte antes de trocar. */
  RETRIES_POR_FONTE: 3,
  /** Backoff entre tentativas. Mais espaçado que o antigo (500ms) de propósito. */
  BACKOFF_MS: [1000, 4000, 10000],
  /**
   * Teto de extrações automáticas por janela. Cada /api/player/extract reserva
   * um slot no Redis (MAX_CONCURRENT = 5, liberado só quando o proxy consome o
   * token). Estourar isso devolve 429 e a recuperação quebraria a reprodução
   * sozinha — por isso o orçamento é de extrações, não de tentativas.
   */
  EXTRACOES_POR_JANELA: 3,
  JANELA_EXTRACAO_MS: 5 * 60 * 1000,
  /** Sem primeiro frame nesse tempo após load(), a fonte não está entregando. */
  T_FIRST_FRAME_MS: 25_000,
  /** Posição parada com o player em buffering. */
  T_STALL_MS: 12_000,
  /** Dois stalls dentro desta janela = a fonte, não a rede. */
  STALL_JANELA_MS: 90_000,
  /** Falhar antes do primeiro frame é barato: nada foi baixado ainda. */
  FAILOVERS_ANTES_FIRSTFRAME: 6,
  /** Depois do primeiro frame, cada troca descarta buffer já pago. */
  FAILOVERS_APOS_FIRSTFRAME: 2,
} as const;

export type EntradaFalha = {
  http?: number;
  jwCode?: number | string;
  mensagem?: string;
  url?: string;
  /** Epoch da fonte quando a requisição COMEÇOU. */
  epochErro: number;
  /** Epoch da fonte agora. */
  epochAtual: number;
};

const ehCancelamento = (texto: string) =>
  /\b(canceled|cancelled|aborted|err_aborted|abort)\b/i.test(texto);

/**
 * Classifica um sinal de falha. A ordem importa: epoch primeiro (um eco da fonte
 * anterior não diz nada sobre a atual), cancelamento em seguida (o HLS cancela
 * requisições o tempo todo ao trocar de qualidade ou fazer seek), e só então o
 * status HTTP.
 */
export function classificarFalha(e: EntradaFalha): { veredito: Veredito; motivo: string } {
  if (e.epochErro !== e.epochAtual) {
    return { veredito: "IGNORAR", motivo: `epoch-antiga(${e.epochErro}≠${e.epochAtual})` };
  }

  const texto = String(e.mensagem ?? "");
  const http = e.http;

  // Cancelamento sem status HTTP é o HLS fazendo o trabalho dele.
  if (!http && ehCancelamento(texto)) {
    return { veredito: "IGNORAR", motivo: "cancelamento-isolado" };
  }

  // O extrator nomeia arquivo removido; o proxy marca com X-Obaflix-Falha.
  if (/n[ãa]o tem mais este arquivo|fonte-morta/i.test(texto)) {
    return { veredito: "FATAL", motivo: "arquivo-removido" };
  }

  if (http === 404 || http === 410) {
    return { veredito: "FATAL", motivo: `http-${http}` };
  }
  if (http === 403 || http === 401) {
    return { veredito: "TOKEN", motivo: `http-${http}` };
  }
  if (http && http >= 500) {
    return { veredito: "TRANSITORIO", motivo: `http-${http}` };
  }
  if (/certificate|ssl|tls|handshake/i.test(texto)) {
    return { veredito: "TRANSITORIO", motivo: "tls" };
  }
  if (/timeout|timed out/i.test(texto)) {
    return { veredito: "TRANSITORIO", motivo: "timeout" };
  }
  if (http && http >= 400) {
    return { veredito: "TRANSITORIO", motivo: `http-${http}` };
  }
  return { veredito: "TRANSITORIO", motivo: "rede" };
}

export type EstadoRecuperacao = {
  retries: number;
  extracoesNaJanela: number;
  failoversAposFirstFrame: number;
  failoversAntesFirstFrame: number;
  houveFirstFrame: boolean;
  temProximaFonte: boolean;
  /** O usuário escolheu este servidor à mão. */
  escolhaManual: boolean;
  /** A fonte pode ser reextraída neste ambiente (bridge nativa ou MP4 web). */
  podeReextrair: boolean;
};

/**
 * Traduz veredito + orçamento em ação.
 *
 * Escolha manual só é sobrescrita por FATAL. Em qualquer outro caso o usuário
 * fica no servidor que pediu, retentando dentro do orçamento — trocar sozinho
 * seria desfazer uma decisão explícita.
 */
export function decidirAcao(
  veredito: Veredito,
  estado: EstadoRecuperacao,
): { acao: Acao; detalhe: string } {
  if (veredito === "IGNORAR") return { acao: "ignorar", detalhe: "sem efeito" };

  const trocar = (): { acao: Acao; detalhe: string } => {
    if (!estado.temProximaFonte) return { acao: "erro", detalhe: "sem fonte seguinte" };
    const teto = estado.houveFirstFrame
      ? LIMITES.FAILOVERS_APOS_FIRSTFRAME
      : LIMITES.FAILOVERS_ANTES_FIRSTFRAME;
    const usados = estado.houveFirstFrame
      ? estado.failoversAposFirstFrame
      : estado.failoversAntesFirstFrame;
    if (usados >= teto) return { acao: "erro", detalhe: `teto de failover (${usados}/${teto})` };
    return { acao: "failover", detalhe: `failover ${usados + 1}/${teto}` };
  };

  if (veredito === "FATAL") return trocar();

  // Daqui para baixo é recuperável; escolha manual nunca troca sozinha.
  if (veredito === "TOKEN") {
    if (!estado.podeReextrair) {
      return estado.escolhaManual
        ? { acao: "erro", detalhe: "403 sem reextração possível (escolha manual)" }
        : trocar();
    }
    if (estado.extracoesNaJanela >= LIMITES.EXTRACOES_POR_JANELA) {
      return estado.escolhaManual
        ? { acao: "erro", detalhe: "orçamento de extração esgotado (escolha manual)" }
        : trocar();
    }
    return { acao: "reextrair", detalhe: `extração ${estado.extracoesNaJanela + 1}/${LIMITES.EXTRACOES_POR_JANELA}` };
  }

  // TRANSITORIO: retenta no lugar. Nunca reextrai — reextrair não conserta 5xx
  // de CDN e ainda gasta um slot de stream na Vercel.
  if (estado.retries < LIMITES.RETRIES_POR_FONTE) {
    return {
      acao: "retry",
      detalhe: `tentativa ${estado.retries + 1}/${LIMITES.RETRIES_POR_FONTE}`,
    };
  }
  if (estado.escolhaManual) {
    return { acao: "erro", detalhe: "orçamento esgotado (escolha manual preservada)" };
  }
  return trocar();
}

/** Espera antes da próxima tentativa, saturando no último degrau. */
export function backoffMs(retries: number): number {
  const escala = LIMITES.BACKOFF_MS;
  return escala[Math.min(retries, escala.length - 1)];
}

/** Identidade estável de uma fonte, para casar erro com servidor. */
export function sourceIdDe(embedUrl: string): string {
  let h = 0;
  for (let i = 0; i < embedUrl.length; i++) {
    h = (Math.imul(31, h) + embedUrl.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Linha única e pesquisável de cada decisão de failover.
 * Aparece no console do navegador e no logcat do Android (via onConsoleMessage).
 */
export function logFailover(dados: {
  servidor: string;
  provider: string;
  sourceId: string;
  tentativa: number;
  motivo: string;
  retries: number;
  acao: Acao;
  escolhido?: string | null;
}): void {
  const linha =
    `[diag/failover] servidor=${dados.servidor} provider=${dados.provider} ` +
    `sourceId=${dados.sourceId} tentativa=${dados.tentativa} motivo=${dados.motivo} ` +
    `retries=${dados.retries} acao=${dados.acao}` +
    (dados.escolhido ? ` escolhido=${dados.escolhido}` : "");
  if (dados.acao === "ignorar") console.log(linha);
  else console.warn(linha);
}
