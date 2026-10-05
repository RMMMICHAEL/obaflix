/**
 * O enforcement do anúncio no ponto onde a fonte de uma ação é entregue.
 *
 * Uma função, chamada de `POST /api/player/fontes` — na criação da sessão de
 * reprodução e, com finalidade `download` ou `transmissao`, na sessão que serve a
 * essas ações. Mora aqui, e não na rota, pelo mesmo motivo que
 * `playbackAuthorization.ts` existe: a regra precisa ser exercitável sem
 * `NextRequest`, sem banco e sem Redis, e a rota precisa continuar fina.
 *
 * ## A diferença entre esta função e `/api/playback/authorize`
 *
 * A rota de autorização **pergunta** e emite desafio ou passe; esta função
 * **cobra**. São dois momentos distintos, e separá-los é o que impede o cliente
 * de virar autoridade: o único vestígio que o servidor aceita é o id que ele
 * mesmo emitiu — concessão depois do anúncio, ou passe quando a política deixou
 * passar sem anúncio.
 *
 * Um cliente que pule `/authorize` e chame `/fontes` direto cai aqui sem
 * concessão, e é recusado. Um cliente que reenvie o mesmo id cai aqui com um id
 * já apagado, e é recusado. Um id de outra finalidade ou de outro conteúdo não
 * casa, e é recusado sem ser queimado.
 */

import { entitlementsDoUsuario } from "../entitlements";
import { monetizacaoAtiva, promocaoTvAtiva, anuncioAndroidAtivo, anuncioElectronAtivo } from "../playbackAuthorization";
import { consumirConcessao, type AlvoDeConcessao, type FinalidadeDeConcessao } from "./concessoes";
import { exigeAnuncio, type ConteudoDeAnuncio, type PlataformaDeExibicao } from "./politica";
import type { Entitlements } from "../entitlements";

export type ResultadoDeAnuncio =
  | { liberado: true; via: "flag_desligada" | "sem_anuncios" | "concessao" }
  | { liberado: false; motivo: "sem_concessao" | "concessao_invalida" | "indeterminado" };

export interface OpcoesDeEnforcement {
  /** A flag global (`MONETIZACAO_ATIVA`) já interpretada. Injetável para o teste. */
  ativa?: boolean;
  /**
   * A flag da promoção da TV (`PROMOCAO_TV_ATIVA`) já interpretada. Só tem efeito
   * quando `entrada.plataforma === "android_tv"`: cobra a concessão da TV sem
   * ligar o enforcement para Web/Android/Electron. Injetável para o teste.
   */
  promocaoTvAtiva?: boolean;
  /**
   * A flag do anúncio do Android móvel (`ANUNCIO_ANDROID_ATIVO`) já interpretada.
   * Só tem efeito quando `entrada.plataforma === "android"`: cobra a concessão do
   * Unity sem ligar o enforcement para Web/Electron/TV. Injetável para o teste.
   */
  anuncioAndroidAtivo?: boolean;
  /**
   * A flag do anúncio do Electron (`ANUNCIO_ELECTRON_ATIVO`) já interpretada. Só
   * tem efeito quando a requisição é do Electron (`entrada.plataforma ===
   * "electron"` ou `entrada.electron`): cobra a concessão do Direct Link sem ligar
   * o enforcement para Web/Android/TV. Injetável para o teste.
   */
  anuncioElectronAtivo?: boolean;
  /** Como resolver os direitos. Injetável para dispensar banco e Redis. */
  resolver?: (userId: string) => Promise<Entitlements>;
  /** Como consumir a concessão. Injetável pelo mesmo motivo. */
  consumir?: (id: string, userId: string) => Promise<boolean>;
}

/**
 * Esta ação pode receber a fonte?
 *
 * Ordem, e cada passo evita um custo ou um erro:
 *
 *  1. **flag desligada libera sem consultar nada** — mesmo bypass de
 *     `autorizarCatalogo` e `limiteDeTelas`. Enquanto o enforcement não está
 *     ligado, esta camada não está no caminho de ninguém;
 *  2. **quem não vê anúncio é liberado sem tocar no Redis de anúncio** — o
 *     assinante não paga por uma consulta que existe para o gratuito, em
 *     nenhuma das três finalidades;
 *  3. **sem concessão, recusa** — inclusive quando o cliente não mandou nada. É
 *     o caso de quem pulou `/authorize`;
 *  4. **consumir decide** — para a finalidade e o alvo pedidos, e consumir
 *     apaga. Reenviar o mesmo id não repete.
 *
 * Falha ao resolver direito vira `indeterminado`, que **recusa**. Fail-closed
 * pelo mesmo critério do resto: não saber se a conta precisa de anúncio não pode
 * virar "não precisa".
 */
export async function autorizarPorAnuncio(
  entrada: {
    userId: string;
    tipo: ConteudoDeAnuncio;
    concessao: string | null;
    instancia?: string | null;
    /** Para que a fonte vai servir. Ausente: reprodução. */
    finalidade?: FinalidadeDeConcessao;
    /** O conteúdo pedido. Concessão com alvo só é aceita para o mesmo alvo. */
    alvo?: AlvoDeConcessao | null;
    /**
     * Plataforma da credencial (`plataformaDaRequisicao`), não do corpo. Só
     * `"android_tv"` reage a `PROMOCAO_TV_ATIVA`; ausente/`web` segue a global.
     */
    plataforma?: PlataformaDeExibicao;
    /**
     * A requisição é do Electron por qualquer sinal (`ehRequisicaoElectron`): o
     * player manda `ambiente: "electron"` para `/fontes`, sem `plataforma` no corpo.
     * Só serve para `ANUNCIO_ELECTRON_ATIVO`; não muda nenhuma outra flag.
     */
    electron?: boolean;
  },
  opcoes: OpcoesDeEnforcement = {},
): Promise<ResultadoDeAnuncio> {
  // Global liga para todos; cada flag específica liga SÓ para a sua plataforma:
  // a da TV para `android_tv`, a do Android para `android`, a do Electron para
  // requisições do Electron. Assim cada uma cobra a sua concessão sem reativar o
  // enforcement das outras (Web segue a global, que está desligada).
  const global = opcoes.ativa ?? monetizacaoAtiva();
  const tvAtiva = opcoes.promocaoTvAtiva ?? promocaoTvAtiva();
  const androidAtiva = opcoes.anuncioAndroidAtivo ?? anuncioAndroidAtivo();
  const electronAtiva = opcoes.anuncioElectronAtivo ?? anuncioElectronAtivo();
  const daRequisicaoElectron =
    entrada.plataforma !== "android_tv" && (entrada.plataforma === "electron" || entrada.electron === true);
  const ativa =
    global ||
    (tvAtiva && entrada.plataforma === "android_tv") ||
    (androidAtiva && entrada.plataforma === "android") ||
    (electronAtiva && daRequisicaoElectron);
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

  const finalidade = entrada.finalidade ?? "reproducao";
  const consumir =
    opcoes.consumir ??
    ((id, userId) => consumirConcessao(id, userId, finalidade, entrada.alvo ?? null, entrada.instancia));

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
