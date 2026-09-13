/**
 * Ações patrocinadas: reproduzir, baixar ou transmitir mediante anúncio.
 *
 * A conta sujeita a anúncio libera **uma** ação por vez assistindo a um anúncio.
 * As três ações passam pelo mesmo fluxo — `/api/playback/authorize` com a
 * finalidade, o modal, `/api/ads/complete` — e o que sai daqui é só o id opaco
 * que o **servidor** emitiu. Quem cobra continua sendo a rota que entrega a
 * fonte, consumindo a concessão da finalidade certa.
 *
 * ## Por que existe separado de `fluxoDoCliente`
 *
 * `executarFluxoDeAnuncio` responde uma situação; quem executa uma ação precisa
 * de uma exceção com significado, para parar tudo no ponto certo:
 *
 *   - **`AcaoCancelada`** — o usuário fechou o modal no X ou foi assinar um plano.
 *     Não é erro e não mostra mensagem: a interface volta ao estado anterior;
 *   - **`AcaoInterrompida`** — motivo comercial ou de liberação (anúncio
 *     indisponível, servidor recusou). Mensagem própria, **nunca** a de "nenhuma
 *     mídia disponível", que fica reservada para falha real de mídia.
 *
 * Nenhuma das duas pode ser engolida como "este servidor falhou, tente o
 * próximo": isso abriria o modal de novo na tentativa seguinte.
 */

import {
  executarFluxoDeAnuncio,
  type PedidoDeAutorizacao,
  type PortasDoFluxo,
} from "./fluxoDoCliente";

/** Para que a liberação vale. Espelha `FINALIDADES` de `concessoes.ts`. */
export type FinalidadeDeAcao = "reproducao" | "download" | "transmissao";

/** O usuário desistiu (X) ou foi escolher um plano. Não é falha. */
export class AcaoCancelada extends Error {
  constructor() {
    super("acao cancelada pelo usuario");
    this.name = "AcaoCancelada";
  }
}

/** A ação não foi liberada por motivo comercial ou de liberação, não de mídia. */
export class AcaoInterrompida extends Error {
  readonly motivo: string;

  constructor(motivo: string) {
    super(`acao interrompida: ${motivo}`);
    this.name = "AcaoInterrompida";
    this.motivo = motivo;
  }
}

/** Comparação por nome: a exceção pode atravessar fronteira de módulo/bundle. */
export function ehAcaoCancelada(e: unknown): e is AcaoCancelada {
  return (e as { name?: unknown } | null)?.name === "AcaoCancelada";
}

export function ehAcaoInterrompida(e: unknown): e is AcaoInterrompida {
  return (e as { name?: unknown } | null)?.name === "AcaoInterrompida";
}

/**
 * Pede ao servidor a liberação de **uma** ação.
 *
 * Devolve o id opaco que a rota da ação vai consumir — concessão depois de um
 * anúncio, ou passe quando a política deixou passar sem anúncio — ou `null`
 * quando a conta não está sujeita a anúncio. Nunca decide nada sozinho.
 */
export async function liberarAcao(
  pedido: PedidoDeAutorizacao & { finalidade: FinalidadeDeAcao },
  portas: PortasDoFluxo,
): Promise<string | null> {
  const fluxo = await executarFluxoDeAnuncio(pedido, portas);
  switch (fluxo.situacao) {
    case "liberado":
      return fluxo.concessao;
    case "cancelado":
      throw new AcaoCancelada();
    case "indisponivel":
      throw new AcaoInterrompida("anuncio_indisponivel");
    default:
      throw new AcaoInterrompida("acao_nao_liberada");
  }
}

/** A tela de planos já existente. O CTA leva à escolha, sem pré-selecionar plano. */
export const ROTA_PLANOS = "/planos";

export type IntencaoNoConvite = "assistir" | "fechar" | "assinar";

/**
 * O que cada botão do convite faz.
 *
 * Só "Assistir anúncio" exibe. Fechar e assinar **cancelam a ação pendente
 * antes de qualquer navegação** — nenhum dos dois libera nada, e nenhum dos dois
 * deixa a ação protegida rodar em segundo plano.
 */
export function efeitoDoConvite(intencao: IntencaoNoConvite): {
  exibirAnuncio: boolean;
  cancelarAcao: boolean;
  navegarPara: string | null;
} {
  switch (intencao) {
    case "assistir":
      return { exibirAnuncio: true, cancelarAcao: false, navegarPara: null };
    case "assinar":
      return { exibirAnuncio: false, cancelarAcao: true, navegarPara: ROTA_PLANOS };
    default:
      return { exibirAnuncio: false, cancelarAcao: true, navegarPara: null };
  }
}
