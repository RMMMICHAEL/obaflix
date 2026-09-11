/**
 * O protocolo de handoff entre concessões, do lado do cliente.
 *
 * Módulo puro: sem React, sem `hls.js`, sem `setTimeout` global. Tudo que toca
 * o mundo entra por parâmetro. Existe assim para poder ser **testado como
 * protocolo**, e não só como uma função de HMAC isolada — o erro que motivou
 * este arquivo foi exatamente um protocolo correto no servidor e ausente no
 * cliente.
 *
 * ## O erro que isto conserta
 *
 * A concessão vale `validoPorSegundos` (5 min). Renovar rotaciona o nonce da
 * sessão, e o edge valida toda URL com o nonce corrente. Na versão anterior, o
 * cliente guardava a `manifestUrl` nova numa referência e **continuava tocando
 * pela antiga** — que, passada a janela de grace, deixa de conferir. O player
 * levava 403 no meio da reprodução.
 *
 * Guardar a URL não é migrar. Migrar é trocar a fonte do player, e é isso que
 * `trocarFonte` faz. O servidor dá uma janela curta (`GRACE_HANDOFF_S`) para a
 * troca acontecer sem buraco; este módulo garante que ela aconteça dentro dela.
 *
 * ## A linha do tempo de uma renovação
 *
 * ```text
 * t=0      concessão A entregue, player tocando por A
 * t=0.6·V  pede renovação  ──► servidor gira o nonce
 *                              A entra em grace (60 s)
 *                              concessão B devolvida
 * t=0.6·V  trocarFonte(B)   ──► player passa a buscar por B
 * t=0.6·V+grace             ──► A morre
 * t=V                       ──► A venceria de qualquer forma
 * ```
 *
 * A renovação acontece **bem antes** do vencimento por dois motivos somados:
 * dar espaço para uma segunda tentativa se a primeira falhar, e fazer a troca
 * no meio da janela em que as duas gerações convivem, nunca na borda.
 *
 * Durante a grace, o edge responde a URL antiga de manifesto devolvendo
 * segmentos já assinados com a geração nova — então, mesmo que a troca demore,
 * a reprodução não corta. A grace é rede, não o mecanismo.
 */

export interface ConcessaoDeCanal {
  sessionId: string;
  manifestUrl: string;
  /** Segundos de validade da `manifestUrl`. */
  validoPorSegundos: number;
  expiraEm: number;
}

export type ResultadoDePedido =
  | { ok: true; concessao: ConcessaoDeCanal }
  /**
   * `definitivo` separa "não adianta insistir" de "tente de novo". Plano que
   * caiu e canal que saiu do ar são definitivos; rede e rate limit não são.
   * Colapsar os dois faria uma oscilação de rede parecer perda de acesso.
   */
  | { ok: false; definitivo: boolean; mensagem?: string };

/** `setTimeout`/`clearTimeout`, injetáveis para o teste controlar o relógio. */
export interface Agenda {
  agendar: (fn: () => void, ms: number) => number;
  cancelar: (id: number) => void;
}

export interface OpcoesDeHandoff {
  canalId: string;
  /** `sessionId` presente renova; ausente resolve do zero. */
  pedir: (canalId: string, sessionId?: string) => Promise<ResultadoDePedido>;
  /**
   * Faz o player realmente passar a usar esta URL.
   *
   * No React é `hls.loadSource(url)` (ou `video.src` no HLS nativo); na TV é
   * `setMediaItem` + `prepare`. Não pode ser "guardar numa variável" — é essa
   * confusão que o módulo existe para impedir.
   */
  trocarFonte: (manifestUrl: string) => void;
  /** Recusa definitiva: a reprodução para e a tela explica. */
  aoPerder: (mensagem: string) => void;
  agenda: Agenda;
  /** Fração da validade em que se renova. 0.6 por padrão. */
  fracaoDeRenovacao?: number;
  /** Espera após falha temporária, em segundos. */
  esperaAposFalhaS?: number;
}

export interface Handoff {
  /** Pede a primeira concessão e entra no ciclo. */
  iniciar: () => Promise<void>;
  parar: () => void;
  /** A concessão em uso. `null` antes da primeira. */
  atual: () => ConcessaoDeCanal | null;
  /** Quantas vezes a fonte do player foi efetivamente trocada. */
  trocas: () => number;
}

const FRACAO_PADRAO = 0.6;
const ESPERA_APOS_FALHA_S = 30;

/**
 * Atraso até a próxima renovação.
 *
 * O piso de 30 s impede que uma validade absurdamente curta (configuração
 * errada, relógio torto) vire um laço de renovação contra o backend.
 */
export function atrasoDeRenovacaoMs(validoPorSegundos: number, fracao = FRACAO_PADRAO): number {
  return Math.max(30, Math.floor(validoPorSegundos * fracao)) * 1000;
}

export function criarHandoff(o: OpcoesDeHandoff): Handoff {
  const fracao = o.fracaoDeRenovacao ?? FRACAO_PADRAO;
  const esperaFalha = (o.esperaAposFalhaS ?? ESPERA_APOS_FALHA_S) * 1000;

  let concessao: ConcessaoDeCanal | null = null;
  let trocas = 0;
  let timer: number | null = null;
  let vivo = true;

  function cancelarTimer() {
    if (timer !== null) {
      o.agenda.cancelar(timer);
      timer = null;
    }
  }

  /**
   * Adota uma concessão: guarda **e** troca a fonte, nesta ordem e sempre
   * juntas. Separar as duas é o bug que este módulo conserta, então elas não
   * têm caminho separado.
   */
  function adotar(nova: ConcessaoDeCanal) {
    concessao = nova;
    trocas++;
    o.trocarFonte(nova.manifestUrl);
  }

  function agendarProxima(validoPorSegundos: number) {
    if (!vivo) return;
    cancelarTimer();
    timer = o.agenda.agendar(() => void renovar(), atrasoDeRenovacaoMs(validoPorSegundos, fracao));
  }

  async function renovar(): Promise<void> {
    if (!vivo) return;
    const anterior = concessao;
    const r = await o.pedir(o.canalId, anterior?.sessionId);
    if (!vivo) return;

    if (r.ok) {
      adotar(r.concessao);
      agendarProxima(r.concessao.validoPorSegundos);
      return;
    }

    if (r.definitivo) {
      // Plano caiu, canal saiu do ar, sessão revogada. Parar é a resposta
      // certa: insistir não traz de volta, e a sessão no servidor já morreu.
      vivo = false;
      cancelarTimer();
      o.aoPerder(r.mensagem ?? "Reprodução encerrada.");
      return;
    }

    // Temporário: o vídeo segue pela concessão atual até ela vencer, e uma nova
    // tentativa cabe antes disso. Não troca a fonte — não há fonte nova.
    if (!vivo) return;
    cancelarTimer();
    timer = o.agenda.agendar(() => void renovar(), esperaFalha);
  }

  return {
    async iniciar() {
      const r = await o.pedir(o.canalId);
      if (!vivo) return;
      if (!r.ok) {
        vivo = false;
        o.aoPerder(r.mensagem ?? "Não foi possível iniciar o canal agora.");
        return;
      }
      adotar(r.concessao);
      agendarProxima(r.concessao.validoPorSegundos);
    },
    parar() {
      vivo = false;
      cancelarTimer();
    },
    atual: () => concessao,
    trocas: () => trocas,
  };
}
