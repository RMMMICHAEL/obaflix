/**
 * Controle de reprodução de um canal, do lado do cliente.
 *
 * Módulo puro: sem React, sem `hls.js`, sem `setTimeout`/relógio global. Tudo
 * que toca o mundo entra por parâmetro, para poder ser **testado como
 * protocolo** — em especial a garantia que mais importa aqui: **re-resolução
 * controlada, sem laço infinito**.
 *
 * ## O modelo: re-resolução em erro, não renovação por relógio
 *
 * A mídia agora é buscada direto pelo aparelho (o `/play` devolve a `streamUrl`,
 * sem proxy nem URL assinada). Essa URL não vence num relógio nosso: vale até o
 * provider rotacionar ou cair. Então não há renovação periódica — há
 * **re-resolução quando a reprodução falha**: o player chama `aoErroDeReproducao`,
 * este módulo pede uma URL nova ao `/play` (com `reresolucao: true`) e troca a
 * fonte.
 *
 * ## Por que um teto, e como ele evita a tempestade
 *
 * Um canal fora do ar falharia, re-resolveria, falharia de novo — um laço tenso
 * contra o `/play` e o provider. O teto é uma **janela deslizante**: no máximo
 * `maxReresolucoes` dentro de `janelaS`. Estourou, `aoPerder` para a reprodução e
 * a tela oferece o "tentar de novo" manual (que recria o controle e zera a
 * contagem). Uma live legítima que precise re-resolver de vez em quando ao longo
 * de horas cabe, porque a janela desliza; uma fonte quebrada é contida em poucos
 * segundos.
 *
 * ## Single-flight
 *
 * Enquanto um pedido está em voo, um novo erro não dispara outro. Vários eventos
 * de erro do `hls.js` para a mesma queda são comuns; sem isto, cada um gastaria
 * uma re-resolução.
 */

export type ResultadoDePedido =
  | { ok: true; streamUrl: string }
  /**
   * `definitivo` separa "não adianta insistir" de "tente de novo". Plano que
   * caiu e canal que saiu do ar são definitivos; rede e rate limit não são.
   */
  | { ok: false; definitivo: boolean; mensagem?: string };

/** `setTimeout`/`clearTimeout`, injetáveis para o teste controlar o relógio. */
export interface Agenda {
  agendar: (fn: () => void, ms: number) => number;
  cancelar: (id: number) => void;
}

export interface OpcoesDeCanal {
  canalId: string;
  /** `reresolucao=false` é a abertura (pode cobrar anúncio); `true` é continuação após erro. */
  pedir: (canalId: string, reresolucao: boolean) => Promise<ResultadoDePedido>;
  /**
   * Faz o player realmente passar a usar esta URL.
   *
   * No React é `hls.loadSource(url)` (ou `video.src` no HLS nativo). Não pode ser
   * "guardar numa variável" — trocar a fonte é o efeito, não guardar a URL.
   */
  trocarFonte: (streamUrl: string) => void;
  /** Recusa definitiva ou teto estourado: a reprodução para e a tela explica. */
  aoPerder: (mensagem: string) => void;
  agenda: Agenda;
  /** Relógio, injetável. `Date.now` por padrão. */
  agora?: () => number;
  /** Teto de re-resoluções dentro de `janelaS`. 3 por padrão. */
  maxReresolucoes?: number;
  /** Janela deslizante do teto, em segundos. 60 por padrão. */
  janelaS?: number;
  /** Espera antes de tentar de novo após falha temporária, em segundos. 3 por padrão. */
  esperaAposFalhaS?: number;
}

export interface ControleDeCanal {
  /** Pede a primeira URL e começa a tocar. */
  iniciar: () => Promise<void>;
  parar: () => void;
  /** O player chama isto num erro fatal de reprodução. */
  aoErroDeReproducao: () => void;
  /** A URL em uso. `null` antes da primeira. */
  fonteAtual: () => string | null;
  /** Quantas re-resoluções por erro foram efetivamente disparadas. */
  reresolucoes: () => number;
}

const MAX_RERESOLUCOES = 3;
const JANELA_S = 60;
const ESPERA_APOS_FALHA_S = 3;

export function criarControleDeCanal(o: OpcoesDeCanal): ControleDeCanal {
  const agora = o.agora ?? (() => Date.now());
  const maxReres = o.maxReresolucoes ?? MAX_RERESOLUCOES;
  const janelaMs = (o.janelaS ?? JANELA_S) * 1000;
  const esperaFalha = (o.esperaAposFalhaS ?? ESPERA_APOS_FALHA_S) * 1000;

  let fonte: string | null = null;
  let reresolucoes = 0;
  let vivo = true;
  let emVoo = false;
  let timer: number | null = null;
  /** Instantes das re-resoluções recentes, para o teto por janela deslizante. */
  const carimbos: number[] = [];

  function cancelarTimer() {
    if (timer !== null) {
      o.agenda.cancelar(timer);
      timer = null;
    }
  }

  function parar() {
    vivo = false;
    cancelarTimer();
  }

  function tetoEstourado(): boolean {
    const limite = agora() - janelaMs;
    while (carimbos.length && carimbos[0] < limite) carimbos.shift();
    return carimbos.length >= maxReres;
  }

  async function reresolver(): Promise<void> {
    if (!vivo || emVoo) return;

    if (tetoEstourado()) {
      // Fonte quebrada de verdade: parar é a resposta certa. O "tentar de novo"
      // manual recria o controle e zera a contagem.
      parar();
      o.aoPerder("Não foi possível manter a transmissão.");
      return;
    }

    carimbos.push(agora());
    reresolucoes++;
    emVoo = true;
    let r: ResultadoDePedido;
    try {
      r = await o.pedir(o.canalId, true);
    } catch {
      r = { ok: false, definitivo: false };
    } finally {
      emVoo = false;
    }
    if (!vivo) return;

    if (r.ok) {
      fonte = r.streamUrl;
      o.trocarFonte(r.streamUrl);
      return;
    }
    if (r.definitivo) {
      parar();
      o.aoPerder(r.mensagem ?? "Reprodução encerrada.");
      return;
    }
    // Temporário (rede, rate limit): espera curta e tenta de novo — ainda sob o
    // teto, que é quem garante o fim do laço.
    cancelarTimer();
    timer = o.agenda.agendar(() => void reresolver(), esperaFalha);
  }

  return {
    async iniciar() {
      if (emVoo) return;
      emVoo = true;
      let r: ResultadoDePedido;
      try {
        r = await o.pedir(o.canalId, false);
      } catch {
        r = { ok: false, definitivo: false };
      } finally {
        emVoo = false;
      }
      if (!vivo) return;
      if (!r.ok) {
        parar();
        o.aoPerder(r.mensagem ?? "Não foi possível iniciar o canal agora.");
        return;
      }
      fonte = r.streamUrl;
      o.trocarFonte(r.streamUrl);
    },
    parar,
    aoErroDeReproducao: () => void reresolver(),
    fonteAtual: () => fonte,
    reresolucoes: () => reresolucoes,
  };
}
