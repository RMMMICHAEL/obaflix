/**
 * A contagem regressiva do convite no Android, como lógica pura.
 *
 * No Android não há botão obrigatório: o convite abre, conta 3 segundos e, ao
 * zerar, chama a ponte nativa sozinho. Essa contagem precisa de três garantias
 * que são fáceis de errar dentro de um `useEffect` e difíceis de provar lá —
 * então vivem aqui, sem DOM, testadas com um relógio injetado:
 *
 *  1. **dispara uma única vez.** Rerender, toque repetido ou dois timers
 *     concorrentes não podem abrir dois anúncios. Depois de zerar, `avancar`
 *     não faz mais nada;
 *  2. **o tempo parado em segundo plano não conta.** Só o tempo com a página
 *     visível é descontado; `marcarVisivel` reancora o relógio ao voltar, então
 *     nem um intervalo totalmente congelado em background "queima" os 3 s;
 *  3. **encerrar é definitivo.** Cancelar (X), desmontar ou concluir chama
 *     `encerrar`, e nenhuma chamada posterior dispara.
 *
 * ## O que esta contagem NÃO é
 *
 * **Não é autoridade.** Zerar só chama `aoZerar` — na prática, pedir à ponte que
 * exiba o anúncio. A concessão continua dependendo do callback nativo e da
 * validação do servidor; os 3 segundos sozinhos nunca liberam reprodução,
 * download ou transmissão.
 */

/** Quanto o convite conta antes de chamar a ponte nativa. */
export const DURACAO_CONTAGEM_ANDROID_MS = 3000;

export interface ContagemAndroid {
  /**
   * Segundos inteiros a mostrar agora: 3 → 2 → 1. Arredonda para cima para o
   * texto bater com o tempo que ainda falta (3000 ms mostra "3", 1 ms mostra
   * "1"). Encerrada ou já disparada, é 0.
   */
  segundosRestantes(): number;
  /**
   * Avança o relógio uma vez. Desconta apenas o tempo decorrido com a página
   * visível; ao cruzar o zero, chama `aoZerar` exatamente uma vez.
   */
  avancar(): void;
  /**
   * A página voltou a ficar visível. Reancora o relógio para que o tempo parado
   * em segundo plano — inclusive quando o próprio intervalo ficou congelado —
   * não seja descontado na primeira passada visível.
   */
  marcarVisivel(): void;
  /** Encerra a contagem. Nenhuma passada posterior desconta nem dispara. */
  encerrar(): void;
}

/**
 * Cria uma contagem regressiva dirigida por fora.
 *
 * Nada de timers nem de DOM aqui: quem chama passa `agora` e `visivel` e bate
 * `avancar` no ritmo que quiser (um `setInterval` na interface, um relógio falso
 * no teste). Assim a mesma lógica é exercitada nos dois lugares.
 */
export function criarContagemAndroid(opcoes: {
  /** Relógio monotônico em milissegundos. Normalmente `Date.now`. */
  agora: () => number;
  /** A página está visível agora? Fora dela, o tempo não é descontado. */
  visivel: () => boolean;
  /** Chamado uma única vez quando a contagem cruza o zero. */
  aoZerar: () => void;
  /** Duração total. Por padrão, `DURACAO_CONTAGEM_ANDROID_MS`. */
  duracaoMs?: number;
}): ContagemAndroid {
  const duracao = opcoes.duracaoMs ?? DURACAO_CONTAGEM_ANDROID_MS;
  let restanteMs = duracao;
  let ultimo = opcoes.agora();
  let disparado = false;
  let encerrada = false;

  return {
    segundosRestantes() {
      if (encerrada || disparado) return 0;
      return Math.max(0, Math.ceil(restanteMs / 1000));
    },
    avancar() {
      if (encerrada || disparado) return;
      const t = opcoes.agora();
      const decorrido = t - ultimo;
      ultimo = t;
      // Invisível: o relógio anda, mas nada é descontado. O texto fica
      // congelado no último valor até a página voltar.
      if (!opcoes.visivel()) return;
      restanteMs -= decorrido;
      if (restanteMs <= 0) {
        restanteMs = 0;
        disparado = true;
        opcoes.aoZerar();
      }
    },
    marcarVisivel() {
      // Reancora: a próxima passada mede a partir de agora, e não do último
      // instante — que pode ter sido antes de um longo trecho em background.
      ultimo = opcoes.agora();
    },
    encerrar() {
      encerrada = true;
    },
  };
}
