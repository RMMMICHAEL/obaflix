/**
 * Resolução dos direitos (entitlements) de um usuário.
 *
 * Responde uma pergunta só, e é a única camada autorizada a respondê-la:
 * **quais direitos esta conta tem agora?**
 *
 * O que este módulo faz, e onde ele para:
 *
 *   - resolve o plano efetivo e projeta os direitos → **sim**
 *   - decide se uma reprodução pode começar → **não**, isso é de
 *     `src/lib/playbackAuthorization.ts`, que consome o resultado daqui
 *   - substitui `MAX_CONCURRENT` de `playTokens.ts` por `telasMax` → **não**
 *
 * Nada aqui bloqueia nada: este módulo só responde. Quem nega é a camada de
 * autorização, e desde a Fase 3 ela é acionada por `POST /api/player/fontes` na
 * criação de sessão nova, atrás de `MONETIZACAO_ATIVA`.
 *
 * ## As regras que não se negociam
 *
 * **O Postgres é a autoridade.** O Redis é cache, e cache que falha ou vem
 * corrompido faz voltar ao Postgres — nunca conceder. Não existe, em lugar
 * nenhum deste arquivo, um objeto de direitos escrito à mão para servir de
 * saída em caso de erro: quando não dá para responder, este módulo **lança**.
 * "Não sei" nunca vira "pode".
 *
 * **O nome do plano não decide nada.** Os direitos saem das colunas explícitas
 * de `Plano`. Nenhuma comparação por `nome` ou por `id` de plano existe aqui, e
 * não deve passar a existir.
 *
 * **`PLANO_GRATUITO` não é fallback.** Aquela constante foi bootstrap da Fase 1
 * e perdeu efeito no instante em que a linha nasceu. O padrão de runtime é a
 * linha com `ehPadrao = true` no banco. Se ela sumir, isto falha alto — que é o
 * comportamento correto, porque um catálogo aberto por engano custa mais do que
 * um erro visível.
 */

import { prisma } from "./prisma";
import { getRedis } from "./redis";
import {
  CANAIS_NIVEIS,
  RESOLUCOES,
  TV_NIVEIS,
  type CanaisNivel,
  type DireitosDoPlano,
  type Resolucao,
  type TvNivel,
} from "./planos";

// ── Contrato de saída ────────────────────────────────────────────────────────

export interface Entitlements {
  assinatura: {
    ativa: boolean;
    /** Qual plano respondeu — o da assinatura, ou o padrão. Para log e suporte. */
    planoId: string;
    /** Sempre `Date` ou `null`, venha do banco ou do cache. Ver `reviver`. */
    expiraEm: Date | null;
  };
  direitos: DireitosDoPlano;
}

/**
 * Por que não foi possível responder.
 *
 * Cada um destes é uma inconsistência real do banco, não um caso de uso. Nenhum
 * tem tratamento permissivo: quem chamar decide o que fazer, e a resposta segura
 * é negar o recurso pago, não liberá-lo.
 */
export type MotivoIndefinido =
  /** Não existe linha com `ehPadrao = true`, ou ela está `ativo = false`. */
  | "sem_plano_padrao"
  /** A assinatura válida aponta para um plano que não veio junto. */
  | "plano_da_assinatura_ausente"
  /** Mais de uma assinatura válida ao mesmo tempo. Ver `resolverEntitlements`. */
  | "assinaturas_ambiguas"
  /** Uma coluna de domínio fechado trouxe valor fora do domínio. */
  | "direito_fora_do_dominio";

export class EntitlementsIndefinidos extends Error {
  constructor(
    readonly motivo: MotivoIndefinido,
    readonly detalhe?: string,
  ) {
    super(`entitlements indefinidos: ${motivo}${detalhe ? ` (${detalhe})` : ""}`);
    this.name = "EntitlementsIndefinidos";
  }
}

// ── Entrada da regra pura ────────────────────────────────────────────────────

/** Um plano, reduzido ao que autoriza. Sem nome, descrição ou timestamps. */
export type PlanoAutorizador = DireitosDoPlano & { id: string };

export interface AssinaturaCandidata {
  id: string;
  status: string;
  iniciaEm: Date;
  terminaEm: Date;
  /** `null` quando a linha veio sem o plano relacionado — ver motivo acima. */
  plano: PlanoAutorizador | null;
}

export interface EntradaDaResolucao {
  agora: Date;
  /**
   * Assinaturas que *podem* estar valendo. A janela é conferida aqui, não por
   * quem consultou: a consulta ao Postgres filtra por índice como otimização, e
   * a regra continua sendo esta função — que é a que os testes exercitam.
   */
  candidatas: AssinaturaCandidata[];
  /** A linha `ehPadrao`. `ativo` importa aqui, e só aqui. */
  planoPadrao: (PlanoAutorizador & { ativo: boolean }) | null;
}

// ── A regra ──────────────────────────────────────────────────────────────────

/**
 * Uma assinatura vale quando está `ATIVA` e agora cai em `[iniciaEm, terminaEm)`.
 *
 * O intervalo é fechado no início e aberto no fim, de propósito: assinatura que
 * começa exatamente agora já vale, e assinatura que termina exatamente agora já
 * não vale. Sem essa convenção, o instante do vencimento pertenceria aos dois
 * lados e uma renovação emendada daria um segundo de direito duplicado — ou
 * nenhum, dependendo de quem comparasse primeiro.
 */
export function assinaturaValida(a: AssinaturaCandidata, agora: Date): boolean {
  if (a.status !== "ATIVA") return false;
  return a.iniciaEm.getTime() <= agora.getTime() && a.terminaEm.getTime() > agora.getTime();
}

/**
 * Função pura: dados os fatos, quais direitos valem.
 *
 * Todo o comportamento observável desta fase está aqui — inclusive as falhas.
 * A infraestrutura acima dela só busca e guarda.
 */
export function resolverEntitlements(entrada: EntradaDaResolucao): Entitlements {
  const validas = entrada.candidatas.filter((a) => assinaturaValida(a, entrada.agora));

  if (validas.length > 1) {
    // O schema ainda não impede duas assinaturas válidas ao mesmo tempo — a
    // trava fica para a fase de renovação/upgrade, junto do fluxo que sabe
    // encerrar a anterior. Até lá, escolher uma seria inventar regra comercial:
    // a de maior privilégio favorece quem duplicou; a mais recente favorece
    // quem recomprou; a mais antiga pune quem fez upgrade. Nenhuma dessas
    // decisões é minha, e errá-la em silêncio é pior do que parar.
    throw new EntitlementsIndefinidos(
      "assinaturas_ambiguas",
      `${validas.length} válidas: ${validas.map((a) => a.id).join(", ")}`,
    );
  }

  if (validas.length === 1) {
    const assinatura = validas[0];
    if (!assinatura.plano) {
      // A FK é RESTRICT, então isto não deveria acontecer. Se acontecer, cair
      // para o gratuito rebaixaria em silêncio quem pagou — e ninguém saberia.
      throw new EntitlementsIndefinidos(
        "plano_da_assinatura_ausente",
        `assinatura ${assinatura.id}`,
      );
    }
    // `Plano.ativo` NÃO é conferido aqui, e é intencional: `ativo = false`
    // significa "saiu de venda", não "perdeu validade". Quem comprou continua
    // com o plano que comprou até `terminaEm`.
    return {
      assinatura: {
        ativa: true,
        planoId: assinatura.plano.id,
        expiraEm: assinatura.terminaEm,
      },
      direitos: apenasDireitos(assinatura.plano),
    };
  }

  const padrao = entrada.planoPadrao;
  if (!padrao || !padrao.ativo) {
    throw new EntitlementsIndefinidos(
      "sem_plano_padrao",
      padrao ? `plano ${padrao.id} está inativo` : "nenhuma linha com ehPadrao",
    );
  }

  return {
    assinatura: { ativa: false, planoId: padrao.id, expiraEm: null },
    direitos: apenasDireitos(padrao),
  };
}

/** Recorta os direitos. Nome, descrição, ordem e timestamps não autorizam nada. */
function apenasDireitos(p: DireitosDoPlano): DireitosDoPlano {
  return {
    anunciosObrigatorios: p.anunciosObrigatorios,
    episodiosPorAnuncio: p.episodiosPorAnuncio,
    janelaAnuncioHoras: p.janelaAnuncioHoras,
    filmes: p.filmes,
    series: p.series,
    canaisNivel: p.canaisNivel,
    downloads: p.downloads,
    telasMax: p.telasMax,
    perfisMax: p.perfisMax,
    resolucaoMax: p.resolucaoMax,
    tvNivel: p.tvNivel,
  };
}

// ── Narrowing dos campos de domínio fechado ──────────────────────────────────

/**
 * O Prisma devolve `String` onde o banco tem CHECK. Converter com `as` esconderia
 * uma linha inválida atrás do tipo; aqui ela vira falha controlada.
 *
 * Na prática o CHECK da migration já impede, então isto é a segunda camada —
 * útil no dia em que alguém aplicar um patch de banco sem a constraint.
 */
function emDominio<T extends string>(
  valor: string,
  aceitos: readonly T[],
  campo: string,
): T {
  if ((aceitos as readonly string[]).includes(valor)) return valor as T;
  throw new EntitlementsIndefinidos("direito_fora_do_dominio", `${campo}="${valor}"`);
}

/** Uma linha de `Plano` como o Prisma a devolve, no que interessa. */
interface LinhaDePlano {
  id: string;
  anunciosObrigatorios: boolean;
  episodiosPorAnuncio: number | null;
  janelaAnuncioHoras: number;
  filmes: boolean;
  series: boolean;
  canaisNivel: string;
  downloads: boolean;
  telasMax: number;
  perfisMax: number;
  resolucaoMax: string;
  tvNivel: string;
}

export function planoDaLinha(linha: LinhaDePlano): PlanoAutorizador {
  return {
    id: linha.id,
    anunciosObrigatorios: linha.anunciosObrigatorios,
    episodiosPorAnuncio: linha.episodiosPorAnuncio,
    janelaAnuncioHoras: linha.janelaAnuncioHoras,
    filmes: linha.filmes,
    series: linha.series,
    canaisNivel: emDominio<CanaisNivel>(linha.canaisNivel, CANAIS_NIVEIS, "canaisNivel"),
    downloads: linha.downloads,
    telasMax: linha.telasMax,
    perfisMax: linha.perfisMax,
    resolucaoMax: emDominio<Resolucao>(linha.resolucaoMax, RESOLUCOES, "resolucaoMax"),
    tvNivel: emDominio<TvNivel>(linha.tvNivel, TV_NIVEIS, "tvNivel"),
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

export const TTL_ENTITLEMENTS_SEG = 120;

/**
 * O TTL que esta entrada pode receber, em segundos. `0` significa "não guarde".
 *
 * Um TTL fixo de 120 s prolongaria assinatura: uma que vence em 10 s entraria no
 * Redis e continuaria respondendo `ativa: true` por quase dois minutos depois do
 * vencimento. Cache é para evitar consulta, não para estender direito.
 *
 * Por isso, para assinatura ativa, o teto é o que falta até `expiraEm`.
 * `Math.floor` de propósito: arredondar para cima faria a entrada sobreviver ao
 * vencimento pela fração de segundo descartada — justamente o que se quer evitar.
 * Sobrando menos de um segundo, o resultado é `0` e nada é guardado; resolver de
 * novo custa uma consulta e responde certo.
 *
 * Plano padrão não vence, então segue com os 120 s inteiros.
 */
export function ttlDoCache(ent: Entitlements, agora: Date): number {
  if (!ent.assinatura.ativa || !ent.assinatura.expiraEm) return TTL_ENTITLEMENTS_SEG;
  const restanteSeg = Math.floor((ent.assinatura.expiraEm.getTime() - agora.getTime()) / 1000);
  if (restanteSeg <= 0) return 0;
  return Math.min(TTL_ENTITLEMENTS_SEG, restanteSeg);
}

/**
 * Uma entrada bem formada ainda pode estar velha demais para autorizar.
 *
 * Segunda camada da mesma defesa que `ttlDoCache` faz na escrita. O TTL do Redis
 * é a primeira, mas depende de o relógio do Redis, o do processo e o momento da
 * gravação concordarem — e de a entrada não ter sido escrita por uma versão
 * anterior deste código. Conferir na leitura não depende de nada disso.
 *
 * Vale a mesma convenção da janela: `expiraEm <= agora` já não autoriza.
 */
export function cacheAindaVale(ent: Entitlements, agora: Date): boolean {
  if (!ent.assinatura.ativa) return true;
  if (!ent.assinatura.expiraEm) return false;
  return ent.assinatura.expiraEm.getTime() > agora.getTime();
}

/**
 * A chave, montada num lugar só.
 *
 * O `v1` é o que permite trocar o formato do valor guardado sem ler lixo da
 * versão anterior: sobe para `v2` e as chaves antigas expiram sozinhas em dois
 * minutos. Sem a versão, um deploy que mudasse o formato leria entradas velhas
 * como se fossem novas — e a validação abaixo cobre isso, mas ao custo de uma
 * consulta a mais por usuário durante a janela inteira.
 */
export function chaveEntitlements(userId: string): string {
  return `entitlements:v1:user:${userId}`;
}

/** O mínimo do Redis que este módulo usa. Trocável nos testes. */
export interface CacheDeEntitlements {
  ler(chave: string): Promise<string | null>;
  gravar(chave: string, valor: string, ttlSeg: number): Promise<void>;
  apagar(chave: string): Promise<void>;
}

/**
 * Monta o cache padrão sobre o Redis.
 *
 * **`getRedis()` roda aqui, na montagem — e não dentro de `ler`/`gravar`.** A
 * posição é o ponto: quem chama esta função a chama fora do `try` que protege
 * as operações, então a recusa por Redis não configurado em produção atravessa,
 * enquanto uma falha de rede num `GET` continua sendo capturada.
 *
 * Antes, `ler` era `(chave) => getRedis().get(chave)`. Como `ler` só é chamada
 * de dentro do `try`, o `throw` de configuração caía no mesmo `catch` do erro
 * operacional e virava "cache miss" — o serviço seguiria em produção sem Redis
 * distribuído, em silêncio, que é o contrário do combinado. Separar os dois
 * casos lá dentro exigiria inspecionar a mensagem do erro, que não é contrato:
 * seria trocar um defeito por outro mais frágil.
 *
 * O cliente é resolvido uma vez e reaproveitado pelos três métodos. `getRedis()`
 * memoriza por processo, então isto não abre conexão nova; o que muda é só
 * *quando* a ausência de configuração aparece.
 */
function criarCacheRedis(): CacheDeEntitlements {
  const redis = getRedis();

  return {
    ler: (chave) => redis.get(chave),
    gravar: async (chave, valor, ttlSeg) => {
      await redis.set(chave, valor, { ex: ttlSeg });
    },
    apagar: async (chave) => {
      await redis.del(chave);
    },
  };
}

/**
 * Reconstrói o objeto guardado, ou devolve `null`.
 *
 * Estrito de propósito: qualquer campo faltando, com tipo errado ou fora do
 * domínio derruba a entrada inteira. O caminho de um cache recusado é uma
 * consulta ao Postgres — barata e correta. O caminho de um cache aceito por
 * engano é conceder direito a partir de bytes que ninguém validou.
 *
 * `expiraEm` volta como `Date`, nunca como a string que o JSON guardou. É o
 * mesmo cuidado que `redis.ts` documenta em `get`: quando o cache devolve um
 * tipo e o banco devolve outro, a divergência só aparece em produção.
 */
export function reviverEntitlements(bruto: string): Entitlements | null {
  let dados: unknown;
  try {
    dados = JSON.parse(bruto);
  } catch {
    return null;
  }
  if (!dados || typeof dados !== "object") return null;

  const { assinatura, direitos } = dados as Record<string, unknown>;
  if (!assinatura || typeof assinatura !== "object") return null;
  if (!direitos || typeof direitos !== "object") return null;

  const a = assinatura as Record<string, unknown>;
  const d = direitos as Record<string, unknown>;

  if (typeof a.ativa !== "boolean") return null;
  if (typeof a.planoId !== "string" || !a.planoId) return null;

  let expiraEm: Date | null = null;
  if (a.expiraEm !== null) {
    if (typeof a.expiraEm !== "string") return null;
    const data = new Date(a.expiraEm);
    if (Number.isNaN(data.getTime())) return null;
    expiraEm = data;
  }
  // Assinatura ativa sem vencimento, ou inativa com vencimento, é uma entrada
  // que este módulo nunca escreveu — não vale tentar interpretar.
  if (a.ativa === (expiraEm === null)) return null;

  const booleanos = ["anunciosObrigatorios", "filmes", "series", "downloads"] as const;
  for (const campo of booleanos) if (typeof d[campo] !== "boolean") return null;

  const inteiros = ["janelaAnuncioHoras", "telasMax", "perfisMax"] as const;
  for (const campo of inteiros) {
    if (typeof d[campo] !== "number" || !Number.isFinite(d[campo] as number)) return null;
  }

  if (d.episodiosPorAnuncio !== null) {
    if (typeof d.episodiosPorAnuncio !== "number" || !Number.isFinite(d.episodiosPorAnuncio)) {
      return null;
    }
  }

  if (typeof d.canaisNivel !== "string" || !(CANAIS_NIVEIS as readonly string[]).includes(d.canaisNivel)) return null;
  if (typeof d.resolucaoMax !== "string" || !(RESOLUCOES as readonly string[]).includes(d.resolucaoMax)) return null;
  if (typeof d.tvNivel !== "string" || !(TV_NIVEIS as readonly string[]).includes(d.tvNivel)) return null;

  return {
    assinatura: { ativa: a.ativa, planoId: a.planoId, expiraEm },
    direitos: {
      anunciosObrigatorios: d.anunciosObrigatorios as boolean,
      episodiosPorAnuncio: d.episodiosPorAnuncio as number | null,
      janelaAnuncioHoras: d.janelaAnuncioHoras as number,
      filmes: d.filmes as boolean,
      series: d.series as boolean,
      canaisNivel: d.canaisNivel as CanaisNivel,
      downloads: d.downloads as boolean,
      telasMax: d.telasMax as number,
      perfisMax: d.perfisMax as number,
      resolucaoMax: d.resolucaoMax as Resolucao,
      tvNivel: d.tvNivel as TvNivel,
    },
  };
}

// ── Fonte de dados ───────────────────────────────────────────────────────────

export interface FonteDeEntitlements {
  candidatas(userId: string, agora: Date): Promise<AssinaturaCandidata[]>;
  planoPadrao(): Promise<(PlanoAutorizador & { ativo: boolean }) | null>;
}

/** Só as colunas que autorizam. `select` estreito para o payload não crescer. */
const COLUNAS_DE_PLANO = {
  id: true,
  anunciosObrigatorios: true,
  episodiosPorAnuncio: true,
  janelaAnuncioHoras: true,
  filmes: true,
  series: true,
  canaisNivel: true,
  downloads: true,
  telasMax: true,
  perfisMax: true,
  resolucaoMax: true,
  tvNivel: true,
} as const;

/**
 * Os argumentos da consulta de assinaturas, montados à parte para poderem ser
 * conferidos sem banco.
 *
 * **A janela inteira precisa estar aqui, não só parte dela.** `take` corta
 * *depois* do filtro: com `iniciaEm` de fora, três assinaturas ATIVAS — duas
 * começando amanhã e uma valendo agora — deixariam o `take: 2` trazer as duas
 * futuras, a função pura descartaria as duas, e a que vale nunca seria vista. O
 * usuário perderia o direito que pagou, e a consulta não teria erro nenhum
 * aparente.
 *
 * Com a janela completa no filtro, `take: 2` passa a significar o que se quer
 * dizer: **duas assinaturas atualmente válidas já bastam para provar
 * ambiguidade**, e não vale trazer mil linhas de uma conta duplicada só para a
 * resolução falhar.
 *
 * `status` + `terminaEm` cobrem `Assinatura_userId_status_terminaEm_idx`;
 * `iniciaEm` é filtro residual sobre um conjunto já pequeno.
 *
 * `assinaturaValida` continua conferindo a janela na função pura. Não é
 * redundância inútil: a regra tem de morar num lugar testável, e a consulta é
 * uma otimização que precisa concordar com ela — o mesmo `agora` atravessa as
 * duas.
 */
export function argumentosDaConsulta(userId: string, agora: Date) {
  return {
    where: {
      userId,
      status: "ATIVA",
      iniciaEm: { lte: agora },
      terminaEm: { gt: agora },
    },
    select: {
      id: true,
      status: true,
      iniciaEm: true,
      terminaEm: true,
      plano: { select: COLUNAS_DE_PLANO },
    },
    orderBy: { terminaEm: "desc" },
    take: 2,
  } as const;
}

const fontePrisma: FonteDeEntitlements = {
  async candidatas(userId, agora) {
    const linhas = await prisma.assinatura.findMany(argumentosDaConsulta(userId, agora));

    return linhas.map((l) => ({
      id: l.id,
      status: l.status,
      iniciaEm: l.iniciaEm,
      terminaEm: l.terminaEm,
      plano: l.plano ? planoDaLinha(l.plano) : null,
    }));
  },

  /**
   * `ativo` vem junto em vez de virar filtro da consulta: a exigência de o
   * plano padrão estar ativo é regra, e regra mora em `resolverEntitlements`,
   * onde os testes a alcançam. Filtrar aqui devolveria `null` e a falha viraria
   * "não existe plano padrão", que é um diagnóstico errado.
   *
   * O índice único parcial de `ehPadrao` garante no máximo uma linha.
   */
  async planoPadrao() {
    const linha = await prisma.plano.findFirst({
      where: { ehPadrao: true },
      select: { ...COLUNAS_DE_PLANO, ativo: true },
    });
    if (!linha) return null;
    const { ativo, ...plano } = linha;
    return { ...planoDaLinha(plano), ativo };
  },
};

// ── Entrada pública ──────────────────────────────────────────────────────────

export interface OpcoesDeResolucao {
  fonte?: FonteDeEntitlements;
  cache?: CacheDeEntitlements;
  /** Injetável para o teste fixar o instante. Um só, usado do início ao fim. */
  agora?: Date;
}

/**
 * Os direitos desta conta, agora.
 *
 * Ordem: cache → Postgres → cache.
 *
 * Duas falhas diferentes, tratadas de formas diferentes:
 *
 * **Operacional** — o cliente existe, mas o `GET` ou o `SET` falhou (rede,
 * Upstash fora, timeout). Capturada: sem cache, a resposta continua vindo do
 * Postgres, que é a autoridade. Não interrompe nada e não concede nada.
 *
 * **De configuração** — em produção, sem `UPSTASH_REDIS_REST_URL`/`TOKEN`,
 * `getRedis()` recusa. **Propaga.** A montagem do cache padrão
 * (`criarCacheRedis()`) acontece antes do `try` abaixo justamente para isso:
 * uma variável obrigatória esquecida tem de aparecer no primeiro pedido, e não
 * virar um serviço rodando sem Redis distribuído sem que ninguém perceba.
 *
 * O `??` importa: com `opcoes.cache` injetado, `criarCacheRedis()` nem é
 * avaliado, e nenhum teste precisa de Redis para exercitar esta função.
 */
export async function entitlementsDoUsuario(
  userId: string,
  opcoes: OpcoesDeResolucao = {},
): Promise<Entitlements> {
  const fonte = opcoes.fonte ?? fontePrisma;
  // Fora do `try` de propósito, e o `??` só avalia isto quando não há cache
  // injetado. Ver o bloco acima sobre as duas falhas.
  const cache = opcoes.cache ?? criarCacheRedis();
  const agora = opcoes.agora ?? new Date();
  const chave = chaveEntitlements(userId);

  let bruto: string | null = null;
  try {
    bruto = await cache.ler(chave);
  } catch {
    // Redis fora do ar não pode derrubar a autorização — só o cache dela.
    bruto = null;
  }

  if (bruto !== null) {
    const doCache = reviverEntitlements(bruto);
    // `cacheAindaVale` é o que impede o cache de prolongar assinatura: uma
    // entrada íntegra, porém já passada de `expiraEm`, não autoriza — recalcula
    // e sobrescreve, como se estivesse corrompida.
    if (doCache && cacheAindaVale(doCache, agora)) return doCache;
    // Entrada corrompida, truncada, vencida, ou de um formato que este módulo
    // não escreveu. Não se aproveita nada dela.
  }

  const [candidatas, planoPadrao] = await Promise.all([
    fonte.candidatas(userId, agora),
    fonte.planoPadrao(),
  ]);

  // Se isto lançar, nada é gravado no cache: uma inconsistência do banco não
  // deve ficar memorizada por dois minutos.
  const resolvido = resolverEntitlements({ agora, candidatas, planoPadrao });

  // Assinatura prestes a vencer recebe TTL menor, ou nenhum. Guardar por 120 s
  // uma assinatura que acaba em 10 estenderia o direito por quase dois minutos.
  const ttl = ttlDoCache(resolvido, agora);
  if (ttl > 0) {
    try {
      await cache.gravar(chave, JSON.stringify(resolvido), ttl);
    } catch {
      // Não conseguir guardar não muda a resposta.
    }
  }

  return resolvido;
}

/**
 * Esquece o que está guardado para esta conta.
 *
 * Existe para quem muda o direito chamar em seguida: ativação de pagamento,
 * cancelamento, estorno, mudança feita por admin. Sem ela, a janela de 120 s
 * viraria o tempo que um usuário fica sem o que acabou de comprar — ou com o
 * que acabou de perder.
 *
 * Nenhum desses fluxos existe ainda; esta fase entrega a função, não a chamada.
 *
 * **Aqui nada é capturado, e é deliberado.** Ao contrário da leitura de cache,
 * onde falhar significa só consultar o Postgres, falhar em invalidar significa
 * deixar de pé por até 120 s um direito que acabou de mudar — um cancelamento
 * que não pega, ou uma compra que não aparece. Quem chamar precisa saber que
 * não deu certo para poder tentar de novo; engolir aqui criaria exatamente a
 * dessincronia que esta função existe para evitar.
 *
 * Pelo mesmo motivo do resto do módulo, a montagem do cache padrão fica fora de
 * qualquer proteção: Redis não configurado em produção recusa, alto.
 */
export async function invalidarEntitlements(
  userId: string,
  cache?: CacheDeEntitlements,
): Promise<void> {
  const alvo = cache ?? criarCacheRedis();
  await alvo.apagar(chaveEntitlements(userId));
}
