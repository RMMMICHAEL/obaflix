/**
 * O enforcement do anúncio no ponto onde a sessão de reprodução nasce.
 *
 * Uma função, chamada de `POST /api/player/fontes`. Mora aqui, e não na rota,
 * pelo mesmo motivo que `playbackAuthorization.ts` existe: a regra precisa ser
 * exercitável sem `NextRequest`, sem banco e sem Redis, e a rota precisa
 * continuar fina.
 *
 * ## A diferença entre esta função e `/api/playback/authorize`
 *
 * A rota de autorização **pergunta** e abre desafio; esta função **cobra**. São
 * dois momentos distintos, e separá-los é o que impede o cliente de virar
 * autoridade: entre um e outro o usuário viu (ou não) o anúncio, e o único
 * vestígio disso que o servidor aceita é a concessão que ele mesmo emitiu.
 *
 * Um cliente que pule `/authorize` e chame `/fontes` direto cai aqui sem
 * concessão, e é recusado. Um cliente que reenvie a mesma concessão cai aqui com
 * um id já apagado, e é recusado.
 */

import { entitlementsDoUsuario } from "../entitlements";
import { monetizacaoAtiva } from "../playbackAuthorization";
import { consumirConcessao } from "./concessoes";
import { exigeAnuncio, type ConteudoDeAnuncio } from "./politica";
import type { Entitlements } from "../entitlements";

export type ResultadoDeAnuncio =
  | { liberado: true; via: "flag_desligada" | "sem_anuncios" | "concessao" }
  | { liberado: false; motivo: "sem_concessao" | "concessao_invalida" | "indeterminado" };

export interface OpcoesDeEnforcement {
  /** A flag já interpretada. Injetável para o teste não mexer no ambiente. */
  ativa?: boolean;
  /** Como resolver os direitos. Injetável para dispensar banco e Redis. */
  resolver?: (userId: string) => Promise<Entitlements>;
  /** Como consumir a concessão. Injetável pelo mesmo motivo. */
  consumir?: (id: string, userId: string) => Promise<boolean>;
}

/**
 * Esta reprodução pode começar?
 *
 * Ordem, e cada passo evita um custo ou um erro:
 *
 *  1. **flag desligada libera sem consultar nada** — mesmo bypass de
 *     `autorizarCatalogo` e `limiteDeTelas`. Enquanto o enforcement não está
 *     ligado, esta camada não está no caminho de ninguém;
 *  2. **quem não vê anúncio é liberado sem tocar no Redis de anúncio** — o
 *     assinante não paga por uma consulta que existe para o gratuito;
 *  3. **sem concessão, recusa** — inclusive quando o cliente não mandou nada. É
 *     o caso de quem pulou `/authorize`;
 *  4. **consumir decide** — e consumir apaga. Reenviar o mesmo id não repete.
 *
 * Falha ao resolver direito vira `indeterminado`, que **recusa**. Fail-closed
 * pelo mesmo critério do resto: não saber se a conta precisa de anúncio não pode
 * virar "não precisa".
 */
export async function autorizarPorAnuncio(
  entrada: { userId: string; tipo: ConteudoDeAnuncio; concessao: string | null },
  opcoes: OpcoesDeEnforcement = {},
): Promise<ResultadoDeAnuncio> {
  const ativa = opcoes.ativa ?? monetizacaoAtiva();
  if (!ativa) return { liberado: true, via: "flag_desligada" };

  const resolver = opcoes.resolver ?? entitlementsDoUsuario;

  let direitos;
  try {
    direitos = (await resolver(entrada.userId)).direitos;
  } catch {
    return { liberado: false, motivo: "indeterminado" };
  }

  if (!exigeAnuncio(direitos)) return { liberado: true, via: "sem_anuncios" };

  if (!entrada.concessao) return { liberado: false, motivo: "sem_concessao" };

  const consumir = opcoes.consumir ?? ((id, userId) => consumirConcessao(id, userId, "reproducao"));

  let ok = false;
  try {
    ok = await consumir(entrada.concessao, entrada.userId);
  } catch {
    // Redis fora no meio do consumo: não dá para afirmar que a concessão era
    // válida nem que foi consumida. Recusar é o lado que não libera de graça.
    return { liberado: false, motivo: "indeterminado" };
  }

  return ok
    ? { liberado: true, via: "concessao" }
    : { liberado: false, motivo: "concessao_invalida" };
}
