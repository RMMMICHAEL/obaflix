/**
 * O estado server-side do fluxo de anúncio: desafio, concessão e contador de
 * episódios.
 *
 * Tudo vive no Redis, e **nada** vive no cliente. `localStorage`,
 * `SharedPreferences` e estado de React não são autoridade comercial aqui — no
 * máximo são cache de interface.
 *
 * ## As três chaves
 *
 * ```text
 * ads:desafio:<id>                        JSON  TTL  5 min   uso único
 * ads:concessao:<id>                      JSON  TTL 30 min   uso único
 * ads:ep:visto:<userId>:<chaveEpisodio>   "1"   TTL janela   SET NX
 * ads:ep:contador:<userId>                INCR  TTL janela
 * ```
 *
 * ## Uso único, e por que `DEL` é suficiente
 *
 * Consumir é `GET` seguido de `DEL`, e o `DEL` é quem decide: ele devolve o
 * número de chaves removidas, então entre duas requisições paralelas que leram a
 * mesma concessão apenas **uma** recebe `1`. A outra recebe `0` e é recusada.
 * Não há janela: o `DEL` é atômico no Redis, e o resultado dele — não o `GET` —
 * é o que autoriza.
 *
 * É o mesmo raciocínio do `SET NX` que `playTokens.ts` já usa para token de
 * stream, com a diferença de que ali o marcador nasce na segunda vez e aqui ele
 * morre na primeira. Escolhi `DEL` porque a concessão precisa carregar dados
 * (usuário, finalidade) e não só existir.
 *
 * ## Finalidade
 *
 * A concessão diz **para que** serve. Uma concessão de reprodução não abre canal
 * ao vivo, download nem nada que venha a existir depois. Sem esse campo, a
 * primeira funcionalidade nova herdaria a autorização da anterior sem ninguém
 * decidir isso.
 */

import crypto from "crypto";

import { getRedis } from "../redis";
import { janelaAnuncioHoras } from "./politica";
import type { ConteudoDeAnuncio } from "./politica";
import type { DireitosDoPlano } from "../planos";

// ── Constantes ───────────────────────────────────────────────────────────────

/** TTL da concessão de reprodução. Valor aprovado. */
export const TTL_CONCESSAO_S = 30 * 60;

/**
 * TTL do desafio.
 *
 * Curto de propósito: é o tempo entre o servidor dizer "veja um anúncio" e o
 * cliente voltar dizendo "vi". Um anúncio recompensado leva menos de um minuto;
 * cinco cobrem carregamento lento e um usuário que hesita, sem deixar um desafio
 * aberto para ser reaproveitado muito depois.
 */
export const TTL_DESAFIO_S = 5 * 60;

/**
 * Quanto tempo, no mínimo, entre abrir o desafio e aceitar a conclusão.
 *
 * Medido pelo relógio do **servidor**, contra o `criadoEm` que ele mesmo gravou
 * — o cliente não informa duração e não teria como ser acreditado se informasse.
 *
 * 6 segundos: um interstitial da Unity fica no ar por volta de 5 a 15, e um
 * Direct Link precisa de tempo para abrir o navegador e carregar. O número é
 * baixo de propósito — ele não existe para provar que o anúncio foi assistido,
 * e sim para que "concluir" não seja instantâneo e automatizável em série. Subir
 * demais começaria a recusar usuário legítimo com conexão rápida, que é o erro
 * caro; o barato é deixar passar quem fechou o anúncio no primeiro segundo.
 */
export const TEMPO_MINIMO_DE_ANUNCIO_MS = 6_000;

/** A única finalidade que existe hoje. Fechada de propósito. */
export const FINALIDADES = ["reproducao"] as const;
export type FinalidadeDeConcessao = (typeof FINALIDADES)[number];

const chaveDesafio = (id: string) => `ads:desafio:${id}`;
const chaveConcessao = (id: string) => `ads:concessao:${id}`;
const chaveContador = (userId: string) => `ads:ep:contador:${userId}`;
const chaveEpisodioVisto = (userId: string, hash: string) => `ads:ep:visto:${userId}:${hash}`;

/** 128 bits. Mesmo critério de `refExterna`: id opaco não é derivado de nada. */
const novoId = () => crypto.randomBytes(16).toString("base64url");

// ── Desafio ──────────────────────────────────────────────────────────────────

export interface Desafio {
  userId: string;
  tipo: ConteudoDeAnuncio;
  /** Plataforma que pediu. Só para log e para escolher a prova esperada. */
  plataforma: PlataformaDeAnuncio;
  criadoEm: number;
}

export type PlataformaDeAnuncio = "android" | "electron";

export function ehPlataformaDeAnuncio(v: unknown): v is PlataformaDeAnuncio {
  return v === "android" || v === "electron";
}

/**
 * Abre um desafio: "esta conta precisa ver um anúncio para liberar isto".
 *
 * O id volta ao cliente; o conteúdo fica aqui. O cliente não consegue forjar um
 * desafio porque não consegue escrever no Redis, e não consegue reaproveitar um
 * porque o consumo apaga.
 */
export async function abrirDesafio(entrada: {
  userId: string;
  tipo: ConteudoDeAnuncio;
  plataforma: PlataformaDeAnuncio;
}): Promise<string> {
  const id = novoId();
  const desafio: Desafio = { ...entrada, criadoEm: Date.now() };
  await getRedis().set(chaveDesafio(id), JSON.stringify(desafio), { ex: TTL_DESAFIO_S });
  return id;
}

/**
 * Consome o desafio. Devolve o conteúdo, ou `null` se não existir / já ter sido
 * usado / pertencer a outra conta.
 *
 * A conferência de dono acontece **depois** do `DEL`, e isso é deliberado: um
 * desafio que alguém tentou usar com a conta errada é um desafio queimado. Ele
 * era de uso único de qualquer forma, e devolvê-lo ao pote daria a um atacante
 * tentativas ilimitadas contra um id que ele já conhece.
 */
export async function consumirDesafio(id: string, userId: string): Promise<Desafio | null> {
  const redis = getRedis();
  const bruto = await redis.get(chaveDesafio(id));
  if (!bruto) return null;

  const removidos = await redis.del(chaveDesafio(id));
  // Duas requisições paralelas leem o mesmo desafio; só quem recebe 1 do `DEL`
  // consumiu de fato. É o `DEL` que autoriza, nunca o `GET`.
  if (removidos !== 1) return null;

  try {
    const d = JSON.parse(bruto) as Desafio;
    if (typeof d.userId !== "string" || d.userId !== userId) return null;
    if (d.tipo !== "filme" && d.tipo !== "serie") return null;
    if (!ehPlataformaDeAnuncio(d.plataforma)) return null;
    return d;
  } catch {
    return null;
  }
}

// ── Concessão ────────────────────────────────────────────────────────────────

export interface Concessao {
  userId: string;
  finalidade: FinalidadeDeConcessao;
  /** Como a conclusão do anúncio foi verificada. Entra no log, não na resposta. */
  verificacao: NivelDeVerificacao;
  criadoEm: number;
}

/**
 * Quanto se sabe sobre o anúncio ter sido realmente assistido.
 *
 * Os dois níveis são reais e a diferença importa — ver
 * `docs/monetizacao-arquitetura.md`. Não existe um terceiro nível "parece que
 * sim": ou o provedor confirmou fora de banda, ou foi o cliente que disse.
 */
export type NivelDeVerificacao =
  /** O provedor confirmou servidor→servidor. Nenhuma rede daqui faz isso hoje. */
  | "hard"
  /** Quem afirmou foi o cliente. É o nível do Direct Link e do interstitial. */
  | "soft";

/**
 * Emite a concessão. Só deve ser chamada depois de um desafio consumido.
 *
 * Devolve o id opaco. O cliente devolve esse id na criação da sessão de fontes,
 * e lá ele é consumido — uma vez.
 */
export async function emitirConcessao(entrada: {
  userId: string;
  finalidade: FinalidadeDeConcessao;
  verificacao: NivelDeVerificacao;
}): Promise<string> {
  const id = novoId();
  const concessao: Concessao = { ...entrada, criadoEm: Date.now() };
  await getRedis().set(chaveConcessao(id), JSON.stringify(concessao), { ex: TTL_CONCESSAO_S });
  return id;
}

/**
 * Existe concessão válida para esta conta, sem consumir?
 *
 * Usada pela decisão (`temConcessao`), que precisa saber se já há autorização
 * antes de abrir um desafio novo. **Não** consome: quem consome é a rota de
 * fontes, no instante em que a sessão nasce.
 */
export async function concessaoValida(id: string | null, userId: string): Promise<boolean> {
  if (!id) return false;
  const bruto = await getRedis().get(chaveConcessao(id));
  if (!bruto) return false;
  try {
    const c = JSON.parse(bruto) as Concessao;
    return c.userId === userId && c.finalidade === "reproducao";
  } catch {
    return false;
  }
}

/**
 * Consome a concessão. `true` só para quem conseguiu de fato.
 *
 * As três conferências não são redundantes:
 *
 *  - **`DEL` devolveu 1** — ninguém mais consumiu esta concessão. É o que faz o
 *    uso único valer sob concorrência;
 *  - **`userId` bate** — uma concessão capturada não libera a conta de outro;
 *  - **`finalidade` bate** — concessão de reprodução não abre outra coisa.
 */
export async function consumirConcessao(
  id: string,
  userId: string,
  finalidade: FinalidadeDeConcessao,
): Promise<boolean> {
  const redis = getRedis();
  const bruto = await redis.get(chaveConcessao(id));
  if (!bruto) return false;

  const removidos = await redis.del(chaveConcessao(id));
  if (removidos !== 1) return false;

  try {
    const c = JSON.parse(bruto) as Concessao;
    return c.userId === userId && c.finalidade === finalidade;
  } catch {
    return false;
  }
}

// ── Contador de episódios distintos ──────────────────────────────────────────

/**
 * A chave de um episódio, para a conta que o abriu.
 *
 * SHA-256 de `userId:conteudoId:temporada:episodio`, como desenhado na seção 9.3
 * da arquitetura. O hash existe para a chave do Redis não carregar o id do
 * conteúdo em claro — quem lê o banco de chaves não fica sabendo o que a conta
 * assiste. Não é segredo criptográfico; é higiene.
 */
export function chaveDoEpisodio(
  userId: string,
  conteudoId: string,
  temporada: number,
  episodio: number,
): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${conteudoId}:${temporada}:${episodio}`)
    .digest("base64url")
    .slice(0, 22);
}

/**
 * Registra um episódio e devolve quantos **distintos** a conta abriu na janela.
 *
 * O `SET NX` é a peça central da regra inteira: só o **primeiro** pedido daquele
 * episódio na janela incrementa o contador. Refresh, retry por erro do player,
 * troca de servidor, reabrir o app, voltar ao mesmo episódio — todos reencontram
 * a chave já gravada e devolvem o contador **sem somar**.
 *
 * A janela é deslizante por episódio (cada chave expira sozinha) e fixa para o
 * contador: o `expire` do contador só é aplicado quando ele nasce, então a
 * janela começa no primeiro episódio do ciclo e não é empurrada para frente a
 * cada episódio novo. Sem isso, quem assiste continuamente nunca fecharia a
 * janela e o ciclo nunca reiniciaria.
 */
export async function registrarEpisodioDistinto(entrada: {
  userId: string;
  conteudoId: string;
  temporada: number;
  episodio: number;
  direitos: DireitosDoPlano;
}): Promise<number> {
  const redis = getRedis();
  const { userId, direitos } = entrada;
  const janelaS = janelaAnuncioHoras(direitos) * 3600;

  const hash = chaveDoEpisodio(userId, entrada.conteudoId, entrada.temporada, entrada.episodio);

  const novo = await redis.set(chaveEpisodioVisto(userId, hash), "1", {
    ex: janelaS,
    nx: true,
  });

  const chave = chaveContador(userId);

  if (novo !== "OK") {
    // Já visto nesta janela: devolve o contador como está, sem somar.
    const atual = await redis.get(chave);
    const n = Number(atual);
    return Number.isInteger(n) && n >= 1 ? n : 1;
  }

  const total = await redis.incr(chave);
  // Só na criação. `INCR` numa chave nova a deixa sem TTL, e reaplicar a cada
  // episódio empurraria a janela para sempre.
  if (total === 1) await redis.expire(chave, janelaS);
  return total;
}

/**
 * Quantos episódios distintos a conta abriu na janela, sem registrar nada.
 *
 * Para diagnóstico e teste. A decisão usa o retorno de
 * `registrarEpisodioDistinto`, porque registrar e contar precisam ser o mesmo
 * passo.
 */
export async function episodiosDistintosNaJanela(userId: string): Promise<number> {
  const atual = await getRedis().get(chaveContador(userId));
  const n = Number(atual);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
