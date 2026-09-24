/**
 * Regras puras da transmissão (Cast) do aplicativo Android.
 *
 * Vive em `src/lib`, e não dentro do componente, pelo mesmo motivo de
 * `androidMedia.ts`: é onde `node --test` roda, e são justamente estas as regras
 * que precisam de prova — que o app externo é verificado **antes** de qualquer
 * anúncio ou resolução de fonte, que uma etapa travada estoura em vez de girar
 * para sempre, e que trocar de servidor na mesma ação nunca abre um segundo
 * anúncio.
 *
 * Nada aqui toca `window`, rede, `Intent` ou React: a ponte nativa, o `fetch` e
 * o anúncio entram como dependências injetadas.
 */

import { ehAcaoCancelada, ehAcaoInterrompida } from "./ads/acaoPatrocinada";

// -- Prazos ------------------------------------------------------------------

/**
 * Tetos de tempo de cada etapa que hoje pode ficar pendente. São limites de
 * segurança contra o "carregando para sempre", não prazos apertados: uma rede
 * lenta ainda cabe. O que importa é que **existe** um fim.
 *
 * O anúncio não tem prazo aqui de propósito: quem controla o tempo dele é a
 * pessoa assistindo, e a política comercial de anúncios não é tocada nesta
 * correção.
 */
export const PRAZO_FONTES_MS = 15_000;
export const PRAZO_FONTE_NATIVA_MS = 15_000;
export const PRAZO_EXTRACAO_MS = 45_000;
export const PRAZO_CAST_MS = 20_000;

// -- Prazo de uma etapa ------------------------------------------------------

/** Uma etapa estourou o prazo. Tratada como "este servidor falhou", não como fim. */
export class EtapaExpirada extends Error {
  readonly etapa: string;

  constructor(etapa: string) {
    super(`etapa expirou: ${etapa}`);
    this.name = "EtapaExpirada";
    this.etapa = etapa;
  }
}

/** Comparação por nome: a exceção pode atravessar fronteira de módulo/bundle. */
export function ehEtapaExpirada(e: unknown): e is EtapaExpirada {
  return (e as { name?: unknown } | null)?.name === "EtapaExpirada";
}

/**
 * Corre uma promessa contra um prazo.
 *
 * Se o trabalho termina primeiro, resolve/rejeita com o que ele deu. Se o prazo
 * vence antes, rejeita com [EtapaExpirada] e chama `aoExpirar` — que é onde o
 * chamador aborta o `fetch`, para não deixar a requisição pendurada depois de
 * já ter desistido dela. Depois que um dos dois lados vence, o outro é ignorado:
 * a promessa nunca resolve nem rejeita duas vezes.
 */
export function corridaComPrazo<T>(
  trabalho: Promise<T>,
  ms: number,
  etapa: string,
  aoExpirar?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let decidido = false;
    const timer = setTimeout(() => {
      if (decidido) return;
      decidido = true;
      try {
        aoExpirar?.();
      } catch {
        /* abortar é acessório: o que importa é rejeitar */
      }
      reject(new EtapaExpirada(etapa));
    }, ms);

    trabalho.then(
      (valor) => {
        if (decidido) return;
        decidido = true;
        clearTimeout(timer);
        resolve(valor);
      },
      (erro) => {
        if (decidido) return;
        decidido = true;
        clearTimeout(timer);
        reject(erro);
      },
    );
  });
}

/**
 * `fetch` com prazo e cancelamento.
 *
 * Ao estourar, aborta a requisição (o `AbortController`) e rejeita com
 * [EtapaExpirada]. Um `signal` já vindo em `init` é respeitado — quem chama pode
 * cancelar antes do prazo.
 */
export function fetchComPrazo(
  input: RequestInfo | URL,
  init: RequestInit,
  ms: number,
  etapa: string,
): Promise<Response> {
  const controlador = new AbortController();
  const externo = init.signal;
  if (externo) {
    if (externo.aborted) controlador.abort();
    else externo.addEventListener("abort", () => controlador.abort(), { once: true });
  }
  return corridaComPrazo(
    fetch(input, { ...init, signal: controlador.signal }),
    ms,
    etapa,
    () => controlador.abort(),
  );
}

// -- Orquestração da transmissão ---------------------------------------------

/** A mídia já resolvida que vai para o app externo. Sem identidade do conteúdo. */
export type FonteParaCast = {
  origem?: string;
  stream?: string;
  tipo?: string;
  referer?: string | null;
  userAgent?: string | null;
  expiresAt?: number | null;
};

/** O que o lado nativo devolve ao receber uma fonte para transmitir. */
export type RespostaDeCast = {
  ok: boolean;
  motivo?: string;
  tentarOutraFonte?: boolean;
  podeInstalar?: boolean;
};

/**
 * O que aconteceu com o toque em "Transmitir", já traduzido para a interface:
 *
 *  - `precisa_app` — o Web Video Cast não está instalado; nenhum anúncio foi
 *    pedido e nenhuma fonte foi resolvida. A tela abre o modal "Aplicativo
 *    necessário";
 *  - `ok` — o app externo recebeu a mídia;
 *  - `cancelado` — a pessoa fechou o convite de anúncio ou foi assinar. Não é
 *    erro: o botão volta ao estado anterior, sem mensagem;
 *  - `erro` — acabaram as fontes, todas falharam ou estouraram o prazo. O botão
 *    volta a ocioso com uma mensagem. `podeInstalar` sinaliza o caso raro do app
 *    ter sumido entre a checagem e a entrega.
 */
export type ResultadoTransmissao =
  | { tipo: "precisa_app" }
  | { tipo: "ok" }
  | { tipo: "cancelado" }
  | { tipo: "erro"; motivo?: string; podeInstalar?: boolean };

/** Teto de servidores tentados num toque em Transmitir. */
export const MAX_TENTATIVAS_DE_CAST = 3;

/**
 * O toque em "Transmitir", como decisão pura.
 *
 * Ordem, e cada passo evita um custo ou uma armadilha:
 *
 *  1. **o app externo antes de tudo** — sem o Web Video Cast não há destino para
 *     a mídia. Perguntar aqui, antes de `resolverFonte`, é o que impede a pessoa
 *     de assistir a um anúncio e esperar uma extração que terminaria em "app
 *     ausente". Não instalado: devolve `precisa_app` sem tocar em mais nada;
 *  2. **uma fonte de cada vez** — `resolverFonte` embute o anúncio (só na
 *     tentativa 0) e o prazo de cada etapa. `null` significa que as fontes
 *     acabaram;
 *  3. **cancelar ou recusar comercialmente encerra** — `AcaoCancelada` vira
 *     `cancelado`; `AcaoInterrompida` vira `erro` com o motivo próprio. Nenhuma
 *     das duas vira "tente o próximo servidor", que reabriria o convite;
 *  4. **falha de servidor tenta o próximo** — rede, extração ou prazo estourado
 *     (`EtapaExpirada`) só derrubam aquele servidor. Como o anúncio e a sessão
 *     são da tentativa 0 e não se repetem, **nenhum segundo anúncio** abre nas
 *     tentativas seguintes;
 *  5. **acabou tentando, é erro** — em vez de spinner infinito.
 */
export async function transmitirComCast(deps: {
  /** O app externo existe? Perguntado ANTES de qualquer anúncio ou resolução. */
  appInstalado: () => Promise<boolean>;
  /**
   * A n-ésima fonte já resolvida — com o anúncio (tentativa 0) e o prazo de cada
   * etapa embutidos. `null` quando as fontes acabaram. Lança `AcaoCancelada`,
   * `AcaoInterrompida` ou erro de servidor (incluindo `EtapaExpirada`).
   */
  resolverFonte: (tentativa: number) => Promise<FonteParaCast | null>;
  /** Entrega a fonte ao app externo, já com o prazo de cast embutido. */
  requestCast: (fonte: FonteParaCast) => Promise<RespostaDeCast>;
  maxTentativas?: number;
}): Promise<ResultadoTransmissao> {
  const { appInstalado, resolverFonte, requestCast, maxTentativas = MAX_TENTATIVAS_DE_CAST } = deps;

  if (!(await appInstalado())) return { tipo: "precisa_app" };

  let ultimo: RespostaDeCast | null = null;
  for (let tentativa = 0; tentativa < maxTentativas; tentativa++) {
    let fonte: FonteParaCast | null;
    try {
      fonte = await resolverFonte(tentativa);
    } catch (erro) {
      if (ehAcaoCancelada(erro)) return { tipo: "cancelado" };
      if (ehAcaoInterrompida(erro)) return { tipo: "erro", motivo: erro.motivo };
      // Só este servidor falhou (rede, extração, prazo). Os próximos ainda podem
      // servir — e não pedem anúncio de novo, pois a sessão é a da tentativa 0.
      continue;
    }
    if (!fonte) break;

    let r: RespostaDeCast;
    try {
      r = await requestCast(fonte);
    } catch {
      // Inclui o prazo do cast estourado: trata como falha desta entrega.
      r = { ok: false };
    }
    ultimo = r;
    if (r.ok) return { tipo: "ok" };
    if (!r.tentarOutraFonte) break;
  }

  return { tipo: "erro", motivo: ultimo?.motivo, podeInstalar: ultimo?.podeInstalar };
}
