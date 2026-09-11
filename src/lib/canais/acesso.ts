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
 * inventar a própria precedência — três chances de divergir. Um índice numa
 * lista não tem esse modo de falha.
 *
 * A comparação vive aqui e em nenhum outro lugar. Se aparecer um segundo
 * `indexOf(CANAIS_NIVEIS)` no repositório, é bug esperando a hora.
 */

import { CANAIS_NIVEIS, type CanaisNivel } from "../planos";

/**
 * Três situações, não duas — mesmo critério de `playbackAuthorization.ts`.
 *
 * `negado` é uma resposta definitiva sobre a conta: o plano não alcança o
 * canal. `indeterminado` não diz nada sobre conta nenhuma — é o banco fora do
 * ar. As duas negam a reprodução; só o que se diz ao usuário muda, e colapsar
 * as duas transformaria incidente de infraestrutura em "você não tem plano".
 */
export type ResultadoDeCanal =
  | { situacao: "permitido" }
  | { situacao: "negado"; nivelExigido: CanaisNivel }
  | { situacao: "indeterminado" };

export function ehNivelDeCanais(v: unknown): v is CanaisNivel {
  return typeof v === "string" && (CANAIS_NIVEIS as readonly string[]).includes(v);
}

/**
 * `true` se `concedido` alcança `exigido` na escala ordenada.
 *
 * Um nível fora do domínio devolve `false`, nunca lança e nunca permite: esta
 * função é chamada no caminho de autorização, e "não sei" ali só pode virar
 * "não".
 */
export function nivelAlcanca(concedido: string, exigido: string): boolean {
  const i = (CANAIS_NIVEIS as readonly string[]).indexOf(concedido);
  const j = (CANAIS_NIVEIS as readonly string[]).indexOf(exigido);
  if (i < 0 || j < 0) return false;
  return i >= j;
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
 * `"nenhum"` como nível concedido nunca alcança nada — nem um canal marcado
 * `nivelMinimo = "nenhum"`, porque `indexOf` devolve 0 para os dois e `0 >= 0`
 * seria `true`. É deliberado que isso **não** seja tratado como caso especial
 * aqui: `nivelMinimo = "nenhum"` significa "canal aberto a qualquer conta com
 * direito a canais", e uma conta em `"nenhum"` tem direito a canais — só não
 * tem direito a nenhum canal acima disso. Se a política mudar, muda aqui.
 */
export function autorizarCanal(
  canal: CanalAutorizavel,
  nivelDaConta: string,
): ResultadoDeCanal {
  if (!ehNivelDeCanais(canal.nivelMinimo)) return { situacao: "indeterminado" };

  // Canal fora do ar ou adulto não é uma decisão sobre a conta: é uma decisão
  // sobre o canal, e a resposta é a mesma para todo mundo. Devolve `negado`
  // com o nível exigido para a rota poder responder 404 sem revelar qual dos
  // dois motivos barrou.
  if (!canal.ativo || canal.adulto) {
    return { situacao: "negado", nivelExigido: canal.nivelMinimo };
  }

  if (!ehNivelDeCanais(nivelDaConta)) return { situacao: "indeterminado" };

  return nivelAlcanca(nivelDaConta, canal.nivelMinimo)
    ? { situacao: "permitido" }
    : { situacao: "negado", nivelExigido: canal.nivelMinimo };
}
