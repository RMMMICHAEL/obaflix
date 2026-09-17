/**
 * O fluxo de anúncio do lado do cliente, como lógica pura.
 *
 * Vive em `src/lib` e não dentro do componente porque é aqui que está a
 * sequência que precisa ser testada — pedir autorização, exibir o anúncio,
 * confirmar, receber a concessão — e um `useCallback` de 3 mil linhas de player
 * não é lugar de prová-la.
 *
 * ## O que este módulo não é
 *
 * **Não é autoridade.** Ele orquestra chamadas; quem decide é o servidor, e a
 * única coisa que atravessa daqui para lá é o id que o servidor mesmo emitiu —
 * desafio, concessão ou passe. Um cliente modificado que pule tudo isto e chame
 * `/fontes` direto é recusado lá, sem concessão — que é o desenho.
 *
 * ## Por que a exibição do anúncio é injetada
 *
 * `exibirAnuncio` entra como porta. No Electron ela abre o Direct Link (o
 * próprio `window.open`, que o Electron já intercepta e manda ao navegador
 * externo); no Android ela chama a ponte nativa. O fluxo é o mesmo nos dois, e
 * é isso que evita duas sequências divergindo com o tempo — a lição que o
 * `CLAUDE.md` tira de ter três ambientes.
 */

export type PlataformaDeAnuncio = "android" | "electron";

/** Para que a liberação vale. Espelha `FINALIDADES` de `concessoes.ts`. */
export type FinalidadeDoPedido = "reproducao" | "download" | "transmissao";

export interface PedidoDeAutorizacao {
  conteudoId: string;
  conteudoTipo: "filme" | "serie" | "canal";
  temporada?: number | null;
  numeroEp?: number | null;
  plataforma: PlataformaDeAnuncio | null;
  /** Reproduzir, baixar ou transmitir. Ausente: reprodução. */
  finalidade?: FinalidadeDoPedido;
}

/** O que `/api/playback/authorize` devolve, reduzido ao que o cliente usa. */
export interface RespostaDeAutorizacao {
  decisao?: unknown;
  desafioId?: unknown;
  directLink?: unknown;
  /**
   * Passe de cota: PERMITIDO para uma conta sujeita a anúncio, sem anúncio
   * agora, com a prova que a rota da ação vai consumir.
   */
  passe?: unknown;
}

/** O que a exibição do anúncio informa de volta. */
export interface ResultadoDaExibicao {
  /** `false` quando o usuário desistiu, foi assinar ou a rede não tinha inventário. */
  concluido: boolean;
}

export interface PortasDoFluxo {
  /** `POST /api/playback/authorize`. */
  autorizar(pedido: PedidoDeAutorizacao): Promise<RespostaDeAutorizacao>;
  /** `POST /api/ads/complete`. Devolve a concessão, ou `null` se recusada. */
  concluir(entrada: { desafioId: string; concluido: boolean }): Promise<string | null>;
  /**
   * Exibe o anúncio. Direct Link no Electron, SDK nativo no Android.
   *
   * Recebe `directLink` só quando o servidor mandou um — e o servidor só manda
   * para Electron com anúncio necessário. `finalidade` vai só quando o pedido a
   * declarou, e serve ao texto do convite.
   */
  exibirAnuncio(entrada: {
    plataforma: PlataformaDeAnuncio;
    desafioId: string;
    directLink?: string;
    finalidade?: FinalidadeDoPedido;
  }): Promise<ResultadoDaExibicao>;
}

export type ResultadoDoFluxo =
  /**
   * Pode seguir. `concessao` é o id que a rota da ação vai consumir — concessão
   * depois do anúncio ou passe de cota — e `null` para quem não está sujeito a
   * anúncio.
   */
  | { situacao: "liberado"; concessao: string | null }
  /** O usuário desistiu de ver o anúncio. */
  | { situacao: "cancelado" }
  /**
   * O servidor exige anúncio e não há meio de exibi-lo nesta plataforma —
   * Electron sem Direct Link configurado, ou navegador comum.
   *
   * Separado de `falhou` de propósito: não houve erro nenhum, e o usuário
   * merece uma mensagem que diga isso. A sessão **não** é aberta.
   */
  | { situacao: "indisponivel" }
  /** Falha de rede ou recusa do servidor. A interface mostra erro, não libera. */
  | { situacao: "falhou" };

/**
 * Roda o fluxo inteiro e devolve o que a rota da ação precisa.
 *
 * Ordem, e cada passo tem um porquê:
 *
 *  1. **pergunta ao servidor.** Sempre — inclusive para quem provavelmente não
 *     precisa. É o servidor que sabe, e perguntar é uma requisição barata contra
 *     o risco de o cliente decidir errado;
 *  2. **PERMITIDO segue direto**, levando o passe quando o servidor mandou um.
 *     Sem passe é o caminho de todo assinante e de toda conta com a flag
 *     desligada; com passe é o episódio que a política deixou passar;
 *  3. **ANUNCIO_NECESSARIO exibe**, e só então confirma;
 *  4. **a concessão vem do servidor** e é devolvida a quem chamou, para entrar
 *     na rota da ação.
 *
 * Desistir não é falha: devolve `cancelado`, e a interface volta ao estado
 * anterior sem mensagem de erro. Quem desistiu de ver anúncio não errou nada.
 */
export async function executarFluxoDeAnuncio(
  pedido: PedidoDeAutorizacao,
  portas: PortasDoFluxo,
): Promise<ResultadoDoFluxo> {
  let resposta: RespostaDeAutorizacao;
  try {
    resposta = await portas.autorizar(pedido);
  } catch {
    return { situacao: "falhou" };
  }

  if (resposta?.decisao === "PERMITIDO") {
    // O passe é só repassado: o cliente não sabe, nem precisa saber, se a conta
    // está sujeita a anúncio. Um valor que não é string não vira concessão.
    const passe = typeof resposta.passe === "string" && resposta.passe ? resposta.passe : null;
    return { situacao: "liberado", concessao: passe };
  }

  // O servidor exige anúncio e sabe que não há como exibi-lo aqui. Não há
  // desafio para cumprir e **não se chama `/fontes`**: ela recusaria de qualquer
  // forma, e o usuário veria "não foi possível carregar os servidores" em vez da
  // razão real.
  if (resposta?.decisao === "ANUNCIO_INDISPONIVEL") return { situacao: "indisponivel" };

  if (resposta?.decisao !== "ANUNCIO_NECESSARIO") {
    // Resposta que não é nenhuma das duas: servidor mais novo, erro, proxy no
    // meio. Não inventa liberação — a sessão não abre e a interface mostra erro.
    return { situacao: "falhou" };
  }

  const desafioId = typeof resposta.desafioId === "string" ? resposta.desafioId : null;
  if (!desafioId || !pedido.plataforma) return { situacao: "falhou" };

  const directLink = typeof resposta.directLink === "string" ? resposta.directLink : undefined;

  let exibicao: ResultadoDaExibicao;
  try {
    exibicao = await portas.exibirAnuncio({
      plataforma: pedido.plataforma,
      desafioId,
      directLink,
      ...(pedido.finalidade ? { finalidade: pedido.finalidade } : {}),
    });
  } catch {
    return { situacao: "falhou" };
  }

  if (!exibicao.concluido) return { situacao: "cancelado" };

  // `concluido` vai junto como informação de produto — o servidor registra e
  // **não** decide por ele. Quem decide lá é o desafio e o tempo mínimo.
  let concessao: string | null;
  try {
    concessao = await portas.concluir({ desafioId, concluido: true });
  } catch {
    return { situacao: "falhou" };
  }

  return concessao ? { situacao: "liberado", concessao } : { situacao: "falhou" };
}
