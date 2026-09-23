/**
 * Decisão comercial de acesso ao catálogo.
 *
 * Fica entre a camada de entitlements (`src/lib/entitlements.ts`, que responde
 * *quais direitos a conta tem*) e as rotas (que respondem *o que fazer com
 * isso*). Existe para as rotas continuarem finas e para a regra ser exercitável
 * sem `NextRequest`, sem Postgres e sem Redis.
 *
 * ## O que esta fase decide
 *
 * Só dois direitos: `filmes` e `series`. E só na **criação de uma sessão nova**
 * de reprodução.
 *
 * Deliberadamente fora daqui, por ora:
 *
 *   - `anunciosObrigatorios`, `episodiosPorAnuncio`, `janelaAnuncioHoras` —
 *     ainda que o banco os traga, esta fase não nega reprodução por falta de
 *     anúncio, não emite concessão e não conta episódio;
 *   - `downloads`, `telasMax`, `perfisMax`, `resolucaoMax`, `tvNivel`,
 *     `canaisNivel` — nenhum é aplicado;
 *   - `MAX_CONCURRENT` de `playTokens.ts` segue sendo 5, e não `telasMax`.
 *
 * ## O que nunca autoriza
 *
 * Nome do plano, `planoId`, `assinatura.ativa`, `role` do JWT, ou qualquer
 * campo enviado pelo cliente. Só o direito explícito, vindo do banco.
 *
 * `assinatura.ativa` merece a menção: é tentador ler "ativa = pode". Não é. Um
 * plano pago pode não incluir séries, e o plano padrão pode incluir tudo — que
 * é exatamente a situação de hoje. Quem decide é o direito.
 */

import { entitlementsDoUsuario } from "./entitlements";
import type { Entitlements } from "./entitlements";
import type { DireitosDoPlano } from "./planos";

export type ConteudoAutorizavel = "filme" | "serie";

/**
 * Três situações, não duas.
 *
 * A separação entre `negado` e `indeterminado` é o ponto: um usuário cujo plano
 * não inclui séries recebe uma resposta definitiva sobre a conta dele; um banco
 * fora do ar não diz nada sobre conta nenhuma. Colapsar os dois em "negado"
 * transformaria incidente de infraestrutura em "você não tem plano" — a mensagem
 * errada para o usuário, e o alarme errado para quem opera.
 *
 * As duas negam a reprodução. Só o que se diz sobre elas muda.
 */
export type ResultadoDeCatalogo =
  | { situacao: "permitido"; via: "flag_desligada" | "direito" }
  | { situacao: "negado" }
  | { situacao: "indeterminado" };

/**
 * A flag de enforcement, lida do ambiente do servidor.
 *
 * **Só a string exata `"true"` liga.** `undefined`, `""`, `"false"`, `"0"`,
 * `"1"` e `"TRUE"` deixam desligado.
 *
 * `Boolean(process.env.MONETIZACAO_ATIVA)` seria o erro clássico aqui:
 * `Boolean("false")` é `true`, então escrever `MONETIZACAO_ATIVA=false` para
 * desligar ligaria. A comparação estrita não tem esse modo de falha.
 *
 * Não existe `NEXT_PUBLIC_` desta variável, e não deve passar a existir: o
 * cliente não precisa saber se o enforcement está ligado, e o que ele não sabe
 * ele não tenta contornar.
 *
 * O parâmetro `env` existe para os testes lerem um objeto próprio em vez de
 * mexerem no ambiente do processo.
 */
export function monetizacaoAtiva(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MONETIZACAO_ATIVA === "true";
}

/**
 * Flag servidor-only, **exclusiva da promoção interna da Android TV**.
 *
 * Existe para a TV exibir seu vídeo institucional em Production **sem** ligar o
 * enforcement global de `MONETIZACAO_ATIVA` (limite de telas, catálogo,
 * downloads, anúncio do celular, Direct Link do Electron). Ela nunca é uma
 * segunda `MONETIZACAO_ATIVA`: só é consultada em conjunto com
 * `plataforma === "android_tv"`, e apenas para o fluxo de promoção da TV
 * (`/playback/authorize`, `/ads/promocao/iniciar`, `/ads/complete` e o consumo
 * da concessão em `/player/fontes`). Web, Android móvel e Electron seguem
 * exatamente o comportamento de `MONETIZACAO_ATIVA=false`.
 *
 * Mesma leitura estrita de `monetizacaoAtiva`: **só a string exata `"true"`
 * liga**. Sem `NEXT_PUBLIC_`. `env` é injetável para o teste.
 */
export function promocaoTvAtiva(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PROMOCAO_TV_ATIVA === "true";
}

/**
 * Flag servidor-only, **exclusiva do anúncio do Android móvel (Unity)**.
 *
 * A irmã de `promocaoTvAtiva`, para a outra plataforma que monetiza. Existe para
 * o celular voltar a exigir o interstitial do Unity em Production **sem** ligar o
 * enforcement global de `MONETIZACAO_ATIVA` (limite de telas, catálogo,
 * downloads, promoção da TV, Direct Link do Electron). Nunca é uma segunda
 * `MONETIZACAO_ATIVA`: só é consultada em conjunto com `plataforma === "android"`,
 * e apenas para o fluxo publicitário do celular (`/playback/authorize`,
 * `/ads/complete` e o consumo da concessão em `/player/fontes`). Web, Android TV
 * e Electron seguem exatamente o comportamento de `MONETIZACAO_ATIVA=false` — a
 * TV continua reagindo só a `PROMOCAO_TV_ATIVA`.
 *
 * Mesma leitura estrita de `monetizacaoAtiva`: **só a string exata `"true"`
 * liga**. Sem `NEXT_PUBLIC_`. `env` é injetável para o teste.
 */
export function anuncioAndroidAtivo(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ANUNCIO_ANDROID_ATIVO === "true";
}

/**
 * O direito que responde por este tipo de conteúdo. Função total e pura.
 *
 * Comparação estrita com `true` de propósito: se um dia um direito chegar
 * `undefined` — coluna nova, cache de formato antigo, projeção incompleta —, o
 * resultado é negar, não conceder por coerção.
 */
export function direitoDeCatalogo(
  direitos: DireitosDoPlano,
  tipo: ConteudoAutorizavel,
): boolean {
  return tipo === "filme" ? direitos.filmes === true : direitos.series === true;
}

export interface OpcoesDeAutorizacao {
  /** A flag já interpretada. Injetável para o teste não mexer no ambiente. */
  ativa?: boolean;
  /** Como resolver os direitos. Injetável para o teste dispensar banco e Redis. */
  resolver?: (userId: string) => Promise<Entitlements>;
}

/**
 * Pode esta conta abrir uma sessão de reprodução para este tipo de conteúdo?
 *
 * Com a flag desligada, devolve `permitido` **sem chamar o resolver**. Isso é
 * requisito, não detalhe de implementação: enquanto o enforcement não estiver
 * ligado, a nova camada não pode custar uma consulta, um comando de Redis, nem
 * um modo de falha novo no caminho de reprodução de todo mundo. Desligada, ela
 * não está no caminho.
 *
 * Com a flag ligada, qualquer falha do resolver vira `indeterminado`, que nega.
 * **Fail-closed**: quando não dá para saber se a conta tem o direito, a resposta
 * segura é não liberar. É o oposto do que um `catch` distraído faria.
 */
export async function autorizarCatalogo(
  userId: string,
  tipo: ConteudoAutorizavel,
  opcoes: OpcoesDeAutorizacao = {},
): Promise<ResultadoDeCatalogo> {
  const ativa = opcoes.ativa ?? monetizacaoAtiva();
  if (!ativa) return { situacao: "permitido", via: "flag_desligada" };

  const resolver = opcoes.resolver ?? entitlementsDoUsuario;

  let entitlements: Entitlements;
  try {
    entitlements = await resolver(userId);
  } catch {
    // Nem o motivo nem o erro saem daqui. Quem chama precisa saber que não deu
    // para decidir; o detalhe vai para o log do servidor, não para a resposta.
    return { situacao: "indeterminado" };
  }

  return direitoDeCatalogo(entitlements.direitos, tipo)
    ? { situacao: "permitido", via: "direito" }
    : { situacao: "negado" };
}

/** O que a rota responde quando não pode liberar. `null` quando pode. */
export interface NegativaDeCatalogo {
  status: 403 | 503;
  corpo: { error: string; codigo: string };
  evento: "playback_negado" | "entitlements_indisponiveis";
}

/**
 * Traduz a decisão em resposta HTTP.
 *
 * Existe separado da rota para o mapeamento ser testável sem `NextRequest` — e
 * para as três escolhas abaixo ficarem num lugar só, em vez de espalhadas por
 * cada rota que vier a enforçar catálogo.
 *
 * **403 e não 401.** O usuário está autenticado; o que falta é direito, não
 * identidade. Responder 401 mandaria o cliente refazer login, que não resolve
 * nada e ainda faz parecer que a sessão expirou.
 *
 * **503 e não 403** quando não deu para resolver. Ver `ResultadoDeCatalogo`.
 *
 * **Corpo curto e estável.** Nada de id de assinatura, motivo de
 * `EntitlementsIndefinidos`, nome de plano ou stack. O `codigo` é o que o
 * cliente pode ler para escolher a tela; o resto é log de servidor.
 */
export function negativaDeCatalogo(r: ResultadoDeCatalogo): NegativaDeCatalogo | null {
  if (r.situacao === "permitido") return null;

  if (r.situacao === "negado") {
    return {
      status: 403,
      corpo: {
        error: "Conteúdo indisponível no seu plano",
        codigo: "conteudo_indisponivel_no_plano",
      },
      evento: "playback_negado",
    };
  }

  return {
    status: 503,
    corpo: {
      error: "Serviço temporariamente indisponível",
      codigo: "entitlements_indisponiveis",
    },
    evento: "entitlements_indisponiveis",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Limite de telas simultâneas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O limite que vale quando o enforcement está desligado.
 *
 * É o `MAX_CONCURRENT` de `playTokens.ts`, repetido aqui pelo mesmo motivo que
 * `TELAS_SIMULTANEAS_HOJE` existe em `planos.ts`: aquele arquivo não exporta a
 * constante. `planos.test.ts` já trava a sincronia entre os três.
 */
export const TELAS_SEM_ENFORCEMENT = 5;

export type ResultadoDeTelas =
  | { situacao: "definido"; limite: number; via: "flag_desligada" | "direito" }
  | { situacao: "indeterminado" };

/**
 * Quantas telas simultâneas esta conta pode ter agora.
 *
 * Mesma forma de `autorizarCatalogo`, e pelos mesmos motivos:
 *
 *   - **flag desligada devolve o limite de hoje sem chamar o resolver.** Com o
 *     enforcement off, esta camada não custa uma consulta, um comando de Redis
 *     nem um modo de falha novo no caminho de reprodução de todo mundo;
 *   - **falha do resolver vira `indeterminado`, que nega.** Fail-closed: quando
 *     não dá para saber quantas telas a conta tem, a resposta segura não é
 *     "cinco".
 *
 * Devolver o **número** em vez de "pode/não pode" é deliberado: quem conta os
 * streams ativos é o sorted set do Redis em `playTokens.ts`, e essa contagem
 * precisa do teto, não de uma decisão já tomada sem ver o estado atual.
 */
export async function limiteDeTelas(
  userId: string,
  opcoes: OpcoesDeAutorizacao = {},
): Promise<ResultadoDeTelas> {
  const ativa = opcoes.ativa ?? monetizacaoAtiva();
  if (!ativa) {
    return { situacao: "definido", limite: TELAS_SEM_ENFORCEMENT, via: "flag_desligada" };
  }

  const resolver = opcoes.resolver ?? entitlementsDoUsuario;

  let entitlements: Entitlements;
  try {
    entitlements = await resolver(userId);
  } catch {
    return { situacao: "indeterminado" };
  }

  const limite = entitlements.direitos.telasMax;
  // Um teto não-inteiro ou menor que 1 não é limite, é linha corrompida. O CHECK
  // do banco recusa `telasMax < 1`, então chegar aqui significa que alguma coisa
  // passou por fora dele — e liberar cinco telas por causa disso seria escolher
  // o lado errado do erro.
  if (!Number.isInteger(limite) || limite < 1) return { situacao: "indeterminado" };

  return { situacao: "definido", limite, via: "direito" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Direitos que o cliente precisa conhecer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O subconjunto dos direitos que a interface precisa para não oferecer o que a
 * conta não tem.
 *
 * **Só `downloads`, e só porque o download é feito pelo cliente.** Todo o resto
 * é decidido no servidor, e o cliente não precisa saber — o que ele não sabe ele
 * não tenta contornar, e um objeto de direitos completo na resposta seria um
 * mapa do que vale a pena atacar.
 */
export interface DireitosDoCliente {
  downloads: boolean;
}

/**
 * Resolve o que o cliente pode saber.
 *
 * Com a flag desligada devolve o comportamento de hoje — download liberado —
 * **sem chamar o resolver**, pela mesma razão de `limiteDeTelas`.
 *
 * Falha do resolver devolve `downloads: false`. Fail-closed, e aqui custa pouco:
 * o usuário perde o botão de baixar por alguns segundos, não a reprodução.
 * Comparação estrita com `true` de propósito — um direito `undefined` vindo de
 * cache de formato antigo não vira permissão por coerção.
 */
export async function direitosDoCliente(
  userId: string,
  opcoes: OpcoesDeAutorizacao = {},
): Promise<DireitosDoCliente> {
  const ativa = opcoes.ativa ?? monetizacaoAtiva();
  if (!ativa) return { downloads: true };

  const resolver = opcoes.resolver ?? entitlementsDoUsuario;

  try {
    const entitlements = await resolver(userId);
    return { downloads: entitlements.direitos.downloads === true };
  } catch {
    return { downloads: false };
  }
}
