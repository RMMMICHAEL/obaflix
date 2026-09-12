/**
 * O estado server-side do fluxo de anúncio: desafio, concessão, passe, marca de
 * pago e contador de episódios.
 *
 * Tudo vive no Redis, e **nada** vive no cliente. `localStorage`,
 * `SharedPreferences` e estado de React não são autoridade comercial aqui — no
 * máximo são cache de interface.
 *
 * ## As chaves
 *
 * ```text
 * ads:desafio:<id>                              JSON  TTL  5 min   uso único
 * ads:concessao:<id>                            JSON  TTL 30 min   uso único  (anúncio)
 * ads:concessao:<id>                            JSON  TTL  5 min   uso único  (passe de cota)
 * ads:pago:<userId>:<finalidade>:<hashAlvo>     "1"   TTL 30 min
 * ads:ep:visto:<userId>:<chaveEpisodio>         "1"   TTL janela   SET NX
 * ads:ep:contador:<userId>                      INCR  TTL janela
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
 * (usuário, finalidade, alvo) e não só existir.
 *
 * ## Finalidade e alvo
 *
 * A concessão diz **para que** serve e **o que** abre. Uma concessão de
 * reprodução não libera download nem transmissão; uma de download não libera
 * transmissão nem reprodução; e nenhuma delas abre outro conteúdo que não o
 * alvo com que nasceu. Sem esses campos, a primeira funcionalidade nova herdaria
 * a autorização da anterior sem ninguém decidir isso.
 *
 * ## Concessão e passe
 *
 * São o mesmo objeto, na mesma chave, consumidos pela mesma regra — a diferença
 * é a origem:
 *
 *   - **concessão** — nasce em `/api/ads/complete`, depois de um anúncio;
 *   - **passe** — nasce em `/api/playback/authorize`, quando a política deixou
 *     passar SEM anúncio (1º e 2º episódio do ciclo, alvo já pago).
 *
 * O passe existe porque "a política deixou" precisa chegar a `/api/player/fontes`
 * como prova emitida pelo servidor. Sem ele, ou `/fontes` recusava o episódio
 * que não devia anúncio — o defeito que motivou esta mudança —, ou passava a
 * confiar num booleano do cliente.
 */

import crypto from "crypto";

import { getRedis } from "../redis";
import { janelaAnuncioHoras } from "./politica";
import type { ConteudoDeAnuncio, PlataformaDeExibicao } from "./politica";
import type { DireitosDoPlano } from "../planos";

// ── Constantes ───────────────────────────────────────────────────────────────

/** TTL da concessão emitida depois de um anúncio. Valor aprovado. */
export const TTL_CONCESSAO_S = 30 * 60;

/**
 * TTL do passe de cota.
 *
 * Curto de propósito: o passe só precisa sobreviver entre `/authorize` dizer
 * "pode" e `/fontes` abrir a sessão, o que leva segundos. Cinco minutos cobrem
 * rede lenta sem deixar uma liberação sem anúncio parada no Redis.
 */
export const TTL_PASSE_S = 5 * 60;

/**
 * Por quanto tempo um alvo de reprodução segue pago depois do anúncio.
 *
 * Igual ao TTL da concessão: é a janela em que reabrir o mesmo filme ou episódio
 * — retry do player, sessão expirada no meio, voltar ao 3º episódio — não pede
 * um segundo anúncio.
 */
export const TTL_PAGO_S = 30 * 60;

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

/** As finalidades que existem. Fechadas de propósito. */
export const FINALIDADES = ["reproducao", "download", "transmissao"] as const;
export type FinalidadeDeConcessao = (typeof FINALIDADES)[number];

export function ehFinalidade(v: unknown): v is FinalidadeDeConcessao {
  return typeof v === "string" && (FINALIDADES as readonly string[]).includes(v);
}

/**
 * A finalidade que o cliente declarou.
 *
 * Ausente vira `reproducao` — é o que todo cliente anterior a esta mudança pede,
 * inclusive o app de TV. Qualquer outro valor vira `null`, que as rotas tratam
 * como pedido inválido: um valor desconhecido nunca cai em "reprodução" por
 * engano.
 */
export function normalizarFinalidade(v: unknown): FinalidadeDeConcessao | null {
  if (v === undefined || v === null) return "reproducao";
  return ehFinalidade(v) ? v : null;
}

/** O conteúdo que uma concessão libera. */
export interface AlvoDeConcessao {
  tipo: ConteudoDeAnuncio;
  conteudoId: string;
  /** `null` para filme. */
  temporada: number | null;
  /** `null` para filme. */
  episodio: number | null;
}

/** Forma canônica do alvo. Filme ignora temporada e episódio. */
export function chaveDoAlvo(alvo: AlvoDeConcessao): string {
  return alvo.tipo === "filme"
    ? `filme:${alvo.conteudoId}`
    : `serie:${alvo.conteudoId}:${alvo.temporada ?? ""}:${alvo.episodio ?? ""}`;
}

function ehAlvo(v: unknown): v is AlvoDeConcessao {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (a.tipo === "filme" || a.tipo === "serie") && typeof a.conteudoId === "string";
}

const chaveDesafio = (id: string) => `ads:desafio:${id}`;
const chaveConcessao = (id: string) => `ads:concessao:${id}`;
const chaveContador = (userId: string) => `ads:ep:contador:${userId}`;
const chaveEpisodioVisto = (userId: string, hash: string) => `ads:ep:visto:${userId}:${hash}`;
const chavePago = (userId: string, finalidade: FinalidadeDeConcessao, hash: string) =>
  `ads:pago:${userId}:${finalidade}:${hash}`;

/** 128 bits. Mesmo critério de `refExterna`: id opaco não é derivado de nada. */
const novoId = () => crypto.randomBytes(16).toString("base64url");

/** Mesma higiene de `chaveDoEpisodio`: a chave não carrega o id do conteúdo em claro. */
function hashDoAlvo(userId: string, alvo: AlvoDeConcessao): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${chaveDoAlvo(alvo)}`)
    .digest("base64url")
    .slice(0, 22);
}

// ── Desafio ──────────────────────────────────────────────────────────────────

export interface Desafio {
  userId: string;
  tipo: ConteudoDeAnuncio;
  /** Plataforma que pediu. Só para log e para escolher a prova esperada. */
  plataforma: PlataformaDeAnuncio;
  /** Para que a concessão que sair daqui vai valer. Gravado pelo servidor. */
  finalidade: FinalidadeDeConcessao;
  /** O conteúdo que o anúncio libera. `null` só em desafio sem alvo. */
  alvo: AlvoDeConcessao | null;
  criadoEm: number;
}

export type PlataformaDeAnuncio = "android" | "electron";

export function ehPlataformaDeAnuncio(v: unknown): v is PlataformaDeAnuncio {
  return v === "android" || v === "electron";
}

/**
 * Normaliza o que o cliente declarou como plataforma.
 *
 * Qualquer coisa que não seja `android` ou `electron` — inclusive ausente, nula
 * ou inventada — vira `"web"`, que é a plataforma **sem meio de exibição**. O
 * desconhecido cai no caso mais restritivo, e não no mais permissivo.
 */
export function normalizarPlataforma(v: unknown): PlataformaDeExibicao {
  return ehPlataformaDeAnuncio(v) ? v : "web";
}

/**
 * Abre um desafio: "esta conta precisa ver um anúncio para liberar isto".
 *
 * O id volta ao cliente; o conteúdo — inclusive finalidade e alvo — fica aqui. O
 * cliente não consegue forjar um desafio porque não consegue escrever no Redis,
 * e não consegue reaproveitar um porque o consumo apaga.
 */
export async function abrirDesafio(entrada: {
  userId: string;
  tipo: ConteudoDeAnuncio;
  plataforma: PlataformaDeAnuncio;
  finalidade?: FinalidadeDeConcessao;
  alvo?: AlvoDeConcessao | null;
}): Promise<string> {
  const id = novoId();
  const desafio: Desafio = {
    userId: entrada.userId,
    tipo: entrada.tipo,
    plataforma: entrada.plataforma,
    finalidade: entrada.finalidade ?? "reproducao",
    alvo: entrada.alvo ?? null,
    criadoEm: Date.now(),
  };
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
 *
 * Desafio gravado antes de existir finalidade é lido como reprodução sem alvo.
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
    const d = JSON.parse(bruto) as Partial<Desafio>;
    if (typeof d.userId !== "string" || d.userId !== userId) return null;
    if (d.tipo !== "filme" && d.tipo !== "serie") return null;
    if (!ehPlataformaDeAnuncio(d.plataforma)) return null;
    const finalidade = d.finalidade === undefined ? "reproducao" : d.finalidade;
    if (!ehFinalidade(finalidade)) return null;
    let alvo: AlvoDeConcessao | null = null;
    if (d.alvo !== undefined && d.alvo !== null) {
      if (!ehAlvo(d.alvo)) return null;
      alvo = d.alvo;
    }
    if (typeof d.criadoEm !== "number") return null;
    return {
      userId: d.userId,
      tipo: d.tipo,
      plataforma: d.plataforma,
      finalidade,
      alvo,
      criadoEm: d.criadoEm,
    };
  } catch {
    return null;
  }
}

// ── Concessão e passe ────────────────────────────────────────────────────────

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

/** De onde a liberação veio. */
export type OrigemDaConcessao =
  /** Um anúncio concluído, em `/api/ads/complete`. */
  | "anuncio"
  /** A política deixou passar sem anúncio, em `/api/playback/authorize`. */
  | "cota";

export interface Concessao {
  userId: string;
  finalidade: FinalidadeDeConcessao;
  origem: OrigemDaConcessao;
  /** Como a conclusão do anúncio foi verificada. `null` no passe de cota. */
  verificacao: NivelDeVerificacao | null;
  /** O único conteúdo que esta concessão abre. `null` só em concessão sem alvo. */
  alvo: AlvoDeConcessao | null;
  criadoEm: number;
}

/**
 * Emite a concessão. Só deve ser chamada depois de um desafio consumido.
 *
 * Devolve o id opaco. O cliente devolve esse id na rota que entrega a fonte da
 * ação, e lá ele é consumido — uma vez, para a mesma finalidade e o mesmo alvo.
 */
export async function emitirConcessao(entrada: {
  userId: string;
  finalidade: FinalidadeDeConcessao;
  verificacao: NivelDeVerificacao;
  alvo?: AlvoDeConcessao | null;
}): Promise<string> {
  const id = novoId();
  const concessao: Concessao = {
    userId: entrada.userId,
    finalidade: entrada.finalidade,
    origem: "anuncio",
    verificacao: entrada.verificacao,
    alvo: entrada.alvo ?? null,
    criadoEm: Date.now(),
  };
  await getRedis().set(chaveConcessao(id), JSON.stringify(concessao), { ex: TTL_CONCESSAO_S });
  return id;
}

/**
 * Emite o passe de cota: a política deixou passar **sem** anúncio.
 *
 * Mesma chave e mesmo consumo da concessão, com alvo obrigatório e TTL curto. É
 * a prova server-side de que o 1º ou 2º episódio do ciclo não devia anúncio —
 * `/fontes` não precisa, e não deve, acreditar num booleano do cliente.
 */
export async function emitirPasse(entrada: {
  userId: string;
  finalidade: FinalidadeDeConcessao;
  alvo: AlvoDeConcessao;
}): Promise<string> {
  const id = novoId();
  const passe: Concessao = {
    userId: entrada.userId,
    finalidade: entrada.finalidade,
    origem: "cota",
    verificacao: null,
    alvo: entrada.alvo,
    criadoEm: Date.now(),
  };
  await getRedis().set(chaveConcessao(id), JSON.stringify(passe), { ex: TTL_PASSE_S });
  return id;
}

/**
 * Existe concessão válida para esta conta e finalidade, sem consumir?
 *
 * Diagnóstico e teste. A decisão de `/authorize` não depende disto: quem prova
 * que um alvo já foi pago é a marca de pago, e quem consome é a rota da ação.
 */
export async function concessaoValida(
  id: string | null,
  userId: string,
  finalidade: FinalidadeDeConcessao = "reproducao",
): Promise<boolean> {
  if (!id) return false;
  const bruto = await getRedis().get(chaveConcessao(id));
  if (!bruto) return false;
  try {
    const c = JSON.parse(bruto) as Concessao;
    return c.userId === userId && c.finalidade === finalidade;
  } catch {
    return false;
  }
}

/**
 * Consome a concessão ou o passe. `true` só para quem conseguiu de fato.
 *
 * As conferências não são redundantes:
 *
 *  - **`DEL` devolveu 1** — ninguém mais consumiu. É o que faz o uso único valer
 *    sob concorrência;
 *  - **`userId` bate** — uma concessão capturada não libera a conta de outro;
 *  - **`finalidade` bate** — reprodução, download e transmissão não se abrem entre
 *    si;
 *  - **`alvo` bate** — o passe do 1º episódio não abre o 3º, e o anúncio de um
 *    filme não abre outro.
 */
export async function consumirConcessao(
  id: string,
  userId: string,
  finalidade: FinalidadeDeConcessao,
  alvo?: AlvoDeConcessao | null,
): Promise<boolean> {
  const redis = getRedis();
  const bruto = await redis.get(chaveConcessao(id));
  if (!bruto) return false;

  let c: Concessao;
  try {
    c = JSON.parse(bruto) as Concessao;
  } catch {
    return false;
  }

  // **Dono, finalidade e alvo ANTES do `DEL`**, e aqui a ordem é o oposto da do
  // desafio — de propósito.
  //
  // Um desafio tentado com a conta errada é queimado: ele é de uso único de
  // qualquer forma, e devolvê-lo ao pote daria tentativas ilimitadas contra um
  // id já conhecido.
  //
  // Uma concessão, não. Apagar aqui deixaria qualquer um que descobrisse o id
  // **negar a reprodução do dono** — um ataque de recusa de serviço contra a
  // vítima, que veria a própria concessão sumir sem explicação. Conferir antes
  // faz a tentativa alheia, ou com o alvo errado, não custar nada a quem tem
  // direito.
  if (c.userId !== userId || c.finalidade !== finalidade) return false;
  if (c.alvo) {
    if (!alvo || chaveDoAlvo(c.alvo) !== chaveDoAlvo(alvo)) return false;
  }

  // Só agora. O `DEL` continua sendo quem autoriza: entre duas requisições
  // legítimas e paralelas do mesmo dono, apenas a que recebe 1 consumiu.
  return (await redis.del(chaveConcessao(id))) === 1;
}

// ── Marca de pago ────────────────────────────────────────────────────────────

/**
 * Registra que esta conta já viu o anúncio que libera este alvo.
 *
 * Quem marca é `/api/ads/complete`, e só para `reproducao`: é o que faz reabrir
 * o mesmo filme ou episódio receber passe em vez de um segundo anúncio. Download
 * e transmissão são liberações pontuais de propósito, e não recebem marca.
 */
export async function marcarPago(entrada: {
  userId: string;
  finalidade: FinalidadeDeConcessao;
  alvo: AlvoDeConcessao;
}): Promise<void> {
  const hash = hashDoAlvo(entrada.userId, entrada.alvo);
  await getRedis().set(chavePago(entrada.userId, entrada.finalidade, hash), "1", { ex: TTL_PAGO_S });
}

/** Este alvo já foi pago por esta conta, para esta finalidade, na janela? */
export async function estaPago(entrada: {
  userId: string;
  finalidade: FinalidadeDeConcessao;
  alvo: AlvoDeConcessao;
}): Promise<boolean> {
  const hash = hashDoAlvo(entrada.userId, entrada.alvo);
  return Boolean(await getRedis().get(chavePago(entrada.userId, entrada.finalidade, hash)));
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
 * Só a reprodução chama isto. Baixar ou transmitir um episódio não é assisti-lo e
 * não entra na cota.
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
