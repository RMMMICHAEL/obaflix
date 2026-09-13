/**
 * O carregamento inicial do player, como estado explícito.
 *
 * ## O problema que isto resolve
 *
 * Tocar em Assistir dispara uma sequência longa — autorização, às vezes anúncio,
 * sessão de fontes, extração, failover automático entre servidores, buffer do
 * primeiro frame — e vários passos dela gravam `status = "error"` na hora em que
 * UMA fonte falha, mesmo com outra tentativa automática a caminho: a lista ainda
 * vai crescer (alternativas chegam depois), a sessão está sendo reaberta, ou o
 * handler que falhou enxergava um tamanho de lista antigo. O usuário via o player
 * vazio e "Servidor: nenhuma mídia disponível" por alguns segundos, e depois a
 * reprodução começava sozinha.
 *
 * ## A regra
 *
 * Enquanto a mídia não ficou pronta pela primeira vez neste título, a tela é a
 * de carregamento (poster, overlay escuro, spinner). Erro de fonte nesse período
 * é tratado como passo intermediário, e só vira tela de erro quando não há mais
 * recuperação pendente — fontes esgotadas, teto de failover atingido ou falha
 * terminal por natureza (sessão expirada, recusa comercial, nenhum servidor).
 *
 * Não há timeout artificial: cada espera aqui termina porque a coisa esperada
 * termina (a sessão responde, as alternativas respondem, a próxima fonte é
 * tentada). Falha real nunca fica mascarada indefinidamente.
 *
 * Nada aqui toca React, rede ou `window`: roda igual em Website, Electron e
 * Android, e é testado em `src/lib/__tests__/playerCarregamento.test.ts`.
 */

export type StatusDoPlayer = "idle" | "extracting" | "loading" | "playing" | "error";

/** O que cobre o player agora. `midia` = nenhum overlay de estado. */
export type TelaDoPlayer = "carregando" | "buffer_nativo" | "erro" | "sem_fontes" | "midia";

export interface EntradaDaTela {
  /** Nenhuma mídia ficou pronta ainda desde que o título foi aberto. */
  carregamentoInicial: boolean;
  status: StatusDoPlayer;
  /** `streamTipo === "native"` (vídeo nativo do Safari/iOS). */
  nativo: boolean;
  autoPlayBlocked: boolean;
  totalDeFontes: number;
  /** A falha é terminal por natureza — não existe outra tentativa possível. */
  erroTerminal: boolean;
}

export function telaDoPlayer(e: EntradaDaTela): TelaDoPlayer {
  if (e.carregamentoInicial) {
    // Erro intermediário não aparece: quem decide se ele é o fim é
    // `passoDoCarregamentoInicial`, que encerra o carregamento inicial quando for.
    if (e.status === "error") return e.erroTerminal ? "erro" : "carregando";
    if (e.status === "playing") return "midia";
    // Autoplay bloqueado no vídeo nativo: a mídia está pronta e só espera o toque,
    // que tem overlay próprio.
    if (e.nativo && e.autoPlayBlocked) return "midia";
    return "carregando";
  }

  // Depois da primeira mídia pronta, o comportamento de sempre.
  if (e.status === "error") return "erro";
  if (e.status === "extracting") return "carregando";
  if (e.status === "loading") {
    if (!e.nativo) return "carregando";
    return e.autoPlayBlocked ? "midia" : "buffer_nativo";
  }
  if (e.status === "idle" && e.totalDeFontes === 0) return "sem_fontes";
  return "midia";
}

export interface SituacaoDoCarregamento {
  carregamentoInicial: boolean;
  status: StatusDoPlayer;
  indiceDaFonte: number;
  totalDeFontes: number;
  /** `/api/player/fontes` (e o que vem antes dele) ainda não respondeu. */
  sessaoPendente: boolean;
  /** A segunda fase de fontes ainda pode acrescentar servidores à lista. */
  alternativasPendentes: boolean;
  erroTerminal: boolean;
  /** O usuário escolheu o servidor: failover automático não passa por cima. */
  escolhaManual: boolean;
  /** Failovers automáticos já feitos antes do primeiro frame. */
  failoversUsados: number;
  /** Teto desses failovers (`LIMITES.FAILOVERS_ANTES_FIRSTFRAME`). */
  tetoDeFailovers: number;
}

/**
 * - `concluir` — a mídia ficou pronta: sai do carregamento inicial.
 * - `trocar_fonte` — a fonte atual falhou e existe a próxima: tenta ela, sem
 *   mostrar o erro da anterior.
 * - `aguardar` — falhou, mas uma recuperação já está a caminho (sessão ou
 *   alternativas); a tela continua em carregamento.
 * - `encerrar_com_erro` — nada mais a tentar: aí, e só aí, o erro aparece.
 * - `nenhum` — nada a fazer agora.
 */
export type PassoDoCarregamento =
  | "concluir"
  | "trocar_fonte"
  | "aguardar"
  | "encerrar_com_erro"
  | "nenhum";

export function passoDoCarregamentoInicial(s: SituacaoDoCarregamento): PassoDoCarregamento {
  if (!s.carregamentoInicial) return "nenhum";
  if (s.status === "playing") return "concluir";
  if (s.status !== "error") return "nenhum";

  if (s.erroTerminal) return "encerrar_com_erro";
  // Sessão sendo aberta (ou reaberta): a lista vai ser substituída, e a falha
  // que chegou agora pertence à anterior.
  if (s.sessaoPendente) return "aguardar";
  if (s.escolhaManual) return "encerrar_com_erro";
  if (s.indiceDaFonte < s.totalDeFontes - 1) {
    // O teto é o mesmo do failover do player: falhar antes do primeiro frame é
    // barato, mas não ilimitado.
    return s.failoversUsados >= s.tetoDeFailovers ? "encerrar_com_erro" : "trocar_fonte";
  }
  // Última fonte da lista atual, mas a lista ainda pode crescer.
  if (s.alternativasPendentes) return "aguardar";
  return "encerrar_com_erro";
}
