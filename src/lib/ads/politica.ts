/**
 * A regra de anúncio, pura.
 *
 * Responde uma pergunta só: **esta intenção de reprodução precisa passar por
 * anúncio?** Não fala com Redis, não fala com banco, não conhece `NextRequest`.
 * Quem busca os fatos é `./concessoes.ts`; quem age sobre a resposta são as
 * rotas.
 *
 * ## O que decide, e o que nunca decide
 *
 * A entrada é **direito**, nunca identidade. Não existe aqui — e não deve passar
 * a existir — comparação por `planoId`, por nome de plano ou por "é assinante".
 * Quem tem `anunciosObrigatorios !== true` sai no primeiro `if`, e é assim que
 * Basic, Plus e Premium nunca entram no fluxo publicitário.
 *
 * A comparação é estrita com `true`: um direito `undefined` — cache de formato
 * antigo, projeção incompleta — **não** liga anúncio por coerção. Falha para o
 * lado que não incomoda quem paga.
 *
 * ## Por que a política mora aqui, e não no cliente
 *
 * A implementação anterior do Android (`SeriesAdFrequencyPolicy` +
 * `PrefsAdCounterStore`, em `local/obaflix-current`) decidia no aparelho, com o
 * contador em `SharedPreferences`. Funcionava como produto e não serve como
 * autoridade comercial: limpar dados do app zerava o ciclo, e nada impedia um
 * cliente modificado de nunca pedir anúncio. O SDK e a ponte daquele trabalho
 * são reaproveitados; a **decisão** subiu para cá.
 */

import type { DireitosDoPlano } from "../planos";

/** O que o usuário está tentando abrir. */
export type ConteudoDeAnuncio = "filme" | "serie";

export type DecisaoDeAnuncio =
  /** Pode reproduzir agora. `via` diz por quê — serve ao log, não ao cliente. */
  | { decisao: "permitido"; via: "sem_anuncios" | "concessao" | "dentro_da_cota" }
  /** Precisa ver anúncio antes. */
  | { decisao: "anuncio_necessario" };

export interface FatosDaDecisao {
  direitos: DireitosDoPlano;
  tipo: ConteudoDeAnuncio;
  /**
   * Já existe concessão de reprodução válida para esta conta?
   *
   * Quem consulta é a rota; aqui entra como fato porque é o que torna esta
   * função pura e testável sem Redis.
   */
  temConcessao: boolean;
  /**
   * Quantos episódios **distintos** esta conta abriu na janela, **incluindo o
   * atual**, depois de registrá-lo.
   *
   * Só faz sentido para `tipo: "serie"`. Vem de `registrarEpisodioDistinto`,
   * que é quem garante que reabrir o mesmo episódio não incrementa.
   */
  episodiosDistintosNaJanela?: number;
}

/**
 * O `N` de "um anúncio a cada N episódios distintos", quando o plano não diz.
 *
 * `Plano.episodiosPorAnuncio` é `Int?` e pode vir nulo — é o caso de todo plano
 * que não exibe anúncio, onde o campo não significa nada. Para um plano que
 * exibe e esqueceu de preencher, cair num default é melhor do que dividir por
 * nulo; 3 é o valor aprovado.
 */
export const EPISODIOS_POR_ANUNCIO_PADRAO = 3;

/** Idem para a janela do contador. */
export const JANELA_ANUNCIO_HORAS_PADRAO = 24;

/**
 * O `N` efetivo deste plano. Sempre inteiro ≥ 1.
 *
 * Um `N` menor que 1 faria todo episódio pedir anúncio, e um não-inteiro faria a
 * comparação por resto nunca fechar. O CHECK do banco já recusa `< 1`; chegar
 * aqui fora do domínio significa que algo passou por fora dele, e o default é
 * mais defensável do que propagar o valor inválido.
 */
export function episodiosPorAnuncio(direitos: DireitosDoPlano): number {
  const n = direitos.episodiosPorAnuncio;
  return typeof n === "number" && Number.isInteger(n) && n >= 1
    ? n
    : EPISODIOS_POR_ANUNCIO_PADRAO;
}

/** A janela, em horas. Mesmo critério de `episodiosPorAnuncio`. */
export function janelaAnuncioHoras(direitos: DireitosDoPlano): number {
  const h = direitos.janelaAnuncioHoras;
  return typeof h === "number" && Number.isInteger(h) && h >= 1
    ? h
    : JANELA_ANUNCIO_HORAS_PADRAO;
}

/** `true` quando esta conta está sujeita a anúncio. */
export function exigeAnuncio(direitos: DireitosDoPlano): boolean {
  return direitos.anunciosObrigatorios === true;
}

/**
 * A decisão. Função total e pura.
 *
 * Ordem, e cada passo tem um motivo:
 *
 *  1. **quem não tem anúncio sai primeiro.** Antes de olhar concessão, contador
 *     ou qualquer outra coisa — é o que garante que um assinante nunca toca no
 *     fluxo publicitário nem paga por uma consulta dele;
 *  2. **concessão válida libera.** Ela é a prova de que o anúncio já aconteceu
 *     nesta janela de 30 min;
 *  3. **filme sempre pede.** Não há cota: cada reprodução nova de filme exige
 *     anúncio, e a concessão do passo 2 é o que cobre as seguintes;
 *  4. **série conta episódios distintos.** O anúncio cai no N-ésimo.
 */
export function decidirAnuncio(fatos: FatosDaDecisao): DecisaoDeAnuncio {
  if (!exigeAnuncio(fatos.direitos)) {
    return { decisao: "permitido", via: "sem_anuncios" };
  }

  if (fatos.temConcessao) {
    return { decisao: "permitido", via: "concessao" };
  }

  if (fatos.tipo === "filme") {
    return { decisao: "anuncio_necessario" };
  }

  // Série. O contador já inclui este episódio — quem registra é a rota, antes
  // de decidir, e o `SET NX` de lá é o que faz reabrir o mesmo episódio não
  // contar de novo.
  const distintos = fatos.episodiosDistintosNaJanela;
  if (typeof distintos !== "number" || !Number.isInteger(distintos) || distintos < 1) {
    // Não saber quantos episódios foram vistos não pode virar "pode assistir de
    // graça". Fail-closed: pede anúncio, que é o lado que não perde receita nem
    // trava ninguém — o usuário vê um anúncio e segue.
    return { decisao: "anuncio_necessario" };
  }

  const n = episodiosPorAnuncio(fatos.direitos);
  // O N-ésimo distinto paga. `3 % 3 === 0` → anúncio; 1 e 2 passam. O resto
  // mantém a cadência em ciclos seguintes (6, 9, …) sem precisar zerar nada.
  return distintos % n === 0
    ? { decisao: "anuncio_necessario" }
    : { decisao: "permitido", via: "dentro_da_cota" };
}
