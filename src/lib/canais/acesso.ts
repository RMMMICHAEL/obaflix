/**
 * A regra de acesso a um canal. Pura, sem banco, sem Redis, sem `NextRequest`.
 *
 * Uma pergunta só: **o nível que esta conta tem alcança o nível que este canal
 * exige?** Quem responde *qual nível a conta tem* é `src/lib/entitlements.ts`;
 * quem faz algo com a resposta são as rotas.
 *
 * ## Por que ordenado, e não três booleanos
 *
 * `canaisNivel` é `"nenhum" < "gratuito" < "plus" < "premium"` — a mesma escala
 * ordenada que `Plano.canaisNivel` guarda e que a migration trava por CHECK.
 * Trocar por `podeGratuito/podePlus/podePremium` permitiria o estado impossível
 * "premium sim, plus não" e obrigaria cada cliente (Android, TV, Electron) a
 * inventar a própria precedência — três chances de divergir.
 *
 * ## Os dois domínios não são o mesmo, e essa é a correção central
 *
 * O nível **da conta** tem quatro valores, e `"nenhum"` é um deles: é como se
 * escreve "esta conta não tem direito a canal nenhum".
 *
 * O nível **mínimo de um canal** tem três: `gratuito`, `plus`, `premium`. Não
 * existe canal exigindo `"nenhum"`, porque isso não quer dizer nada — e a
 * versão anterior deste arquivo tratava os dois domínios como um só. O efeito
 * era um buraco real: `nivelAlcanca("nenhum", "nenhum")` comparava índice 0 com
 * índice 0, dava `0 >= 0`, e uma conta sem direito a canal nenhum recebia
 * autorização para um canal marcado `"nenhum"` — que a migration e a ferramenta
 * de curadoria deixavam criar.
 *
 * A correção tem três camadas, de propósito:
 *
 *   1. `nivelMinimo` só aceita os três (aqui, no CHECK do banco e no script);
 *   2. `nivelAlcanca` nega **sempre** que o concedido for `"nenhum"`, antes de
 *      qualquer comparação de índice;
 *   3. `autorizarCanal` devolve `indeterminado` para `nivelMinimo` fora do
 *      domínio estreito, em vez de deixar passar.
 *
 * Qualquer uma delas sozinha fecharia o caso. As três existem porque a primeira
 * depende de uma migration que pode ser revertida, e a terceira depende de o
 * banco estar coerente.
 */

import { CANAIS_NIVEIS, type CanaisNivel } from "../planos";

/**
 * Os níveis que um **canal** pode exigir.
 *
 * Subconjunto de `CANAIS_NIVEIS` sem `"nenhum"`. Espelho do CHECK
 * `Canal_nivelMinimo_dominio` da migration `20260911_canais`.
 */
export const NIVEIS_MINIMOS_DE_CANAL = ["gratuito", "plus", "premium"] as const;

export type NivelMinimoDeCanal = (typeof NIVEIS_MINIMOS_DE_CANAL)[number];

/**
 * Três situações, não duas — mesmo critério de `playbackAuthorization.ts`.
 *
 * `negado` é uma resposta definitiva sobre a conta: o plano não alcança o
 * canal. `indeterminado` não diz nada sobre conta nenhuma — é o banco fora do
 * ar, ou uma linha com valor fora do domínio. As duas negam a reprodução; só o
 * que se diz ao usuário muda, e colapsar as duas transformaria incidente de
 * infraestrutura em "você não tem plano".
 */
export type ResultadoDeCanal =
  | { situacao: "permitido" }
  | { situacao: "negado"; nivelExigido: NivelMinimoDeCanal }
  | { situacao: "indeterminado" };

export function ehNivelDeCanais(v: unknown): v is CanaisNivel {
  return typeof v === "string" && (CANAIS_NIVEIS as readonly string[]).includes(v);
}

export function ehNivelMinimoDeCanal(v: unknown): v is NivelMinimoDeCanal {
  return typeof v === "string" && (NIVEIS_MINIMOS_DE_CANAL as readonly string[]).includes(v);
}

/**
 * `true` se `concedido` alcança `exigido` na escala ordenada.
 *
 * Duas recusas vêm **antes** da comparação de índice, e nenhuma das duas é
 * redundante:
 *
 *   - `concedido === "nenhum"` nega sempre. "Direito a canal nenhum" não pode
 *     alcançar canal algum, e é exatamente o caso que o `0 >= 0` deixava passar.
 *   - `exigido` fora de `NIVEIS_MINIMOS_DE_CANAL` nega. Um canal com nível
 *     inválido não é um canal aberto.
 *
 * Nível desconhecido devolve `false`, nunca lança e nunca permite: esta função
 * é chamada no caminho de autorização, e "não sei" ali só pode virar "não".
 */
export function nivelAlcanca(concedido: string, exigido: string): boolean {
  if (concedido === "nenhum") return false;
  if (!ehNivelMinimoDeCanal(exigido)) return false;
  if (!ehNivelDeCanais(concedido)) return false;

  const i = (CANAIS_NIVEIS as readonly string[]).indexOf(concedido);
  const j = (CANAIS_NIVEIS as readonly string[]).indexOf(exigido);
  return i >= j;
}

/**
 * Os níveis mínimos que uma conta neste nível consegue abrir.
 *
 * É a forma que a consulta de catálogo usa para filtrar no banco, em vez de
 * trazer tudo e decidir em memória. Lista vazia para `"nenhum"` e para valor
 * fora do domínio — e lista vazia quer dizer catálogo vazio, não catálogo
 * inteiro. Quem chama precisa tratar assim.
 */
export function niveisAlcancadosPor(nivelDaConta: string): NivelMinimoDeCanal[] {
  return NIVEIS_MINIMOS_DE_CANAL.filter((exigido) => nivelAlcanca(nivelDaConta, exigido));
}

/** O canal, na parte que a decisão de acesso precisa conhecer. */
export interface CanalAutorizavel {
  nivelMinimo: string;
  ativo: boolean;
  adulto: boolean;
}

/**
 * A decisão completa sobre um canal.
 *
 * Canal fora do ar ou adulto não é decisão sobre a conta: é decisão sobre o
 * canal, e a resposta é a mesma para todo mundo. Devolve `negado` para a rota
 * poder responder 404 sem revelar qual dos dois motivos barrou.
 */
export function autorizarCanal(
  canal: CanalAutorizavel,
  nivelDaConta: string,
): ResultadoDeCanal {
  // Fora do domínio estreito é inconsistência de dado, não resposta sobre a
  // conta — inclusive o `"nenhum"` que a versão anterior aceitava aqui.
  if (!ehNivelMinimoDeCanal(canal.nivelMinimo)) return { situacao: "indeterminado" };

  if (!canal.ativo || canal.adulto) {
    return { situacao: "negado", nivelExigido: canal.nivelMinimo };
  }

  if (!ehNivelDeCanais(nivelDaConta)) return { situacao: "indeterminado" };

  return nivelAlcanca(nivelDaConta, canal.nivelMinimo)
    ? { situacao: "permitido" }
    : { situacao: "negado", nivelExigido: canal.nivelMinimo };
}
