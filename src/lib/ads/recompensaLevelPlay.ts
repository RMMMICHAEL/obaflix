import crypto from "node:crypto";
import { getRedis } from "@/lib/redis";

/**
 * Recompensa do LevelPlay (Rewarded) para abrir a reprodução, confirmada servidor→servidor.
 *
 * Reaproveita o desafio `ANUNCIO_NECESSARIO` de `/api/playback/authorize` e a concessão de
 * `/api/ads/complete`. Nada aqui concede conteúdo: este módulo só guarda **o recibo** de que o
 * LevelPlay creditou um evento para um desafio. Quem emite a concessão continua sendo `/ads/complete`.
 *
 * ## Duas amarras, porque a assinatura oficial só cobre uma
 *
 * Contrato: `md5(TIMESTAMP + EVENT_ID + USER_ID + REWARDS + PRIVATE_KEY)`. O `dynamicUserId` chega como
 * parâmetro **fora** da assinatura. Por isso nenhum dos dois basta sozinho:
 *
 *  1. **Conta (assinada).** O `USER_ID` é um identificador opaco que o *backend* emite para a conta
 *     autenticada (`identidadeDoLevelPlay`) e que o app entrega a `LevelPlayInitRequest.withUserId`
 *     antes do `init`. O evento assinado resolve para uma conta, nunca para um desafio.
 *  2. **Desafio (único pendente).** Cada conta tem no máximo **um** desafio Rewarded pendente
 *     (`prepararRecompensa`, SET NX). O evento só vale se o `dynamicUserId` — segredo aleatório de uso
 *     único emitido para aquele desafio — coincidir com o do desafio pendente daquela conta.
 *
 * Um evento antigo e legítimo que chegue tarde traz o segredo de outro desafio e é recusado; um evento
 * de outra conta resolve para outra conta; o mesmo evento repetido é reconhecido sem novo recibo.
 *
 * Limite que continua valendo (documentação oficial): formato do anúncio, ad unit e APK de origem não
 * são assinados. Não há prova disso aqui.
 */

export const TTL_PENDENTE_S = 6 * 60; // o desafio vive 5 min; o callback precisa de folga
export const TTL_RECIBO_S = 30 * 60;
export const TTL_EVENTO_S = 9 * 24 * 60 * 60; // as reentregas do LevelPlay duram 8 dias
export const TTL_IDENTIDADE_S = 30 * 24 * 60 * 60;
/** A doc oficial não diz o fuso do timestamp: aceita-se ±26 h até confirmar com um callback real. */
export const JANELA_TIMESTAMP_MS = 26 * 60 * 60 * 1000;

/** IPs de origem listados na documentação oficial de event handlers do LevelPlay. */
export const IPS_DO_LEVELPLAY: readonly string[] = [
  "79.125.5.179", "79.125.26.193", "79.125.117.130", "176.34.224.39", "176.34.224.41", "176.34.224.49",
  "34.194.180.125", "34.196.56.165", "34.196.251.81", "34.196.253.23", "54.88.253.218", "54.209.185.78",
];

type Env = Record<string, string | undefined>;

/** Flag própria do Rewarded no player. Só a string exata `"true"` liga. */
export const recompensaPlayerAtiva = (env: Env = process.env) => env.ANUNCIO_REWARDED_PLAYER_ATIVO === "true";
/** Receptor do callback. Não concede nada sozinho. */
export const receptorS2sAtivo = (env: Env = process.env) => env.LEVELPLAY_S2S_RECEIVER_ENABLED === "true";
/** A chave vem do ambiente; sem ela (ou curta demais) o receptor não existe. Nunca há valor padrão. */
export function chavePrivadaS2s(env: Env = process.env): string | null {
  const k = env.LEVELPLAY_S2S_PRIVATE_KEY;
  return typeof k === "string" && k.length >= 32 ? k : null;
}
/** App Key (id público do painel) esperado no callback. Opcional: se definido, evento de outro app é recusado. */
export const appKeyEsperada = (env: Env = process.env): string | null => {
  const k = env.LEVELPLAY_APP_KEY?.trim();
  return k ? k : null;
};
/** O IP do chamador só é conferido contra a lista oficial; desligar é decisão explícita de homologação. */
export const conferirIpDoLevelPlay = (env: Env = process.env) => env.LEVELPLAY_S2S_IP_ALLOWLIST_DESLIGADA !== "true";

export interface ArmazemDeRecompensa {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null>;
  del(key: string): Promise<number>;
}

const kIdentidade = (userId: string) => `ads:lp:uid:${userId}`;
const kIdentidadeReversa = (lpUid: string) => `ads:lp:ur:${lpUid}`;
const kPendente = (userId: string) => `ads:lp:ativo:${userId}`;
const kModo = (d: string) => `ads:lp:modo:${d}`;
const kRecibo = (d: string) => `ads:lp:r:${d}`;
const kEvento = (e: string) => `ads:lp:e:${e}`;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX48 = /^[0-9a-f]{48}$/;

function lerJson<T>(bruto: string | null): T | null {
  if (!bruto) return null;
  try { return JSON.parse(bruto) as T; } catch { return null; }
}

function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ── Identidade da conta no LevelPlay ─────────────────────────────────────────

/**
 * O `USER_ID` que o app entrega a `LevelPlayInitRequest.withUserId`. Estável por conta (o SDK só inicializa
 * uma vez por processo), opaco (32 hex, nada de e-mail nem id interno) e emitido só para a própria conta.
 */
export async function identidadeDoLevelPlay(userId: string, store: ArmazemDeRecompensa = getRedis()): Promise<string> {
  const atual = await store.get(kIdentidade(userId));
  if (atual && HEX32.test(atual)) {
    await store.set(kIdentidadeReversa(atual), userId, { ex: TTL_IDENTIDADE_S }); // renova junto, sem trocar o valor
    return atual;
  }
  const nova = crypto.randomBytes(16).toString("hex");
  await store.set(kIdentidadeReversa(nova), userId, { ex: TTL_IDENTIDADE_S });
  const ganhou = await store.set(kIdentidade(userId), nova, { ex: TTL_IDENTIDADE_S, nx: true });
  if (ganhou) return nova;
  const vencedora = await store.get(kIdentidade(userId));
  if (vencedora && HEX32.test(vencedora)) return vencedora;
  throw new Error("identidade nao persistida");
}

// ── Preparar ─────────────────────────────────────────────────────────────────

export class RecompensaEmAndamento extends Error {
  constructor() { super("ja ha um Rewarded pendente para esta conta"); }
}

/**
 * Reserva o único desafio Rewarded pendente da conta e devolve o segredo do `dynamicUserId`.
 *
 * Idempotente para o mesmo desafio; outro desafio da mesma conta enquanto houver um pendente lança
 * [RecompensaEmAndamento]. Trava o desafio no modo Rewarded (o Interstitial não o consome). Quem chama já
 * conferiu que o desafio é desta conta, de reprodução e do Android.
 */
export async function prepararRecompensa(
  entrada: { userId: string; desafioId: string },
  store: ArmazemDeRecompensa = getRedis(),
): Promise<{ dynamicUserId: string }> {
  const nonce = crypto.randomBytes(24).toString("hex");
  const registro = JSON.stringify({ desafioId: entrada.desafioId, nonce, em: Date.now() });
  const ganhou = await store.set(kPendente(entrada.userId), registro, { ex: TTL_PENDENTE_S, nx: true });
  if (!ganhou) {
    const atual = lerJson<{ desafioId?: unknown; nonce?: unknown }>(await store.get(kPendente(entrada.userId)));
    if (atual && atual.desafioId === entrada.desafioId && typeof atual.nonce === "string" && HEX48.test(atual.nonce)) {
      return { dynamicUserId: atual.nonce };
    }
    throw new RecompensaEmAndamento();
  }
  await store.set(kModo(entrada.desafioId), "rewarded", { ex: TTL_PENDENTE_S });
  return { dynamicUserId: nonce };
}

export async function modoDoDesafio(desafioId: string, store: ArmazemDeRecompensa = getRedis()): Promise<"rewarded" | null> {
  return (await store.get(kModo(desafioId))) === "rewarded" ? "rewarded" : null;
}

/** O recibo do desafio, ou `null`. Só existe depois de um callback assinado e aceito. */
export async function reciboDoDesafio(desafioId: string, store: ArmazemDeRecompensa = getRedis()): Promise<{ eventId: string } | null> {
  const r = lerJson<{ eventId?: unknown }>(await store.get(kRecibo(desafioId)));
  return r && typeof r.eventId === "string" ? { eventId: r.eventId } : null;
}

/** Estado para o cliente: este desafio é o pendente desta conta? o recibo já chegou? */
export async function estadoDaRecompensa(
  entrada: { userId: string; desafioId: string },
  store: ArmazemDeRecompensa = getRedis(),
): Promise<{ preparado: boolean; confirmada: boolean }> {
  const p = lerJson<{ desafioId?: unknown }>(await store.get(kPendente(entrada.userId)));
  if (!p || p.desafioId !== entrada.desafioId) return { preparado: false, confirmada: false };
  return { preparado: true, confirmada: (await reciboDoDesafio(entrada.desafioId, store)) !== null };
}

/**
 * O cliente desistiu (anúncio fechado sem recompensa, falha, demora, troca de conta): libera o **slot** de Rewarded
 * pendente da conta para que ela possa tentar de novo. Não destrava o desafio (`modo` fica), então ele nunca vira
 * Interstitial depois de um Rewarded ter sido reservado para ele. Um evento que chegue depois é recusado
 * (o pendente não existe mais). Com recibo já gravado não faz nada: a confirmação vale.
 */
export async function cancelarRecompensa(
  entrada: { userId: string; desafioId: string },
  store: ArmazemDeRecompensa = getRedis(),
): Promise<{ cancelada: boolean }> {
  const p = lerJson<{ desafioId?: unknown }>(await store.get(kPendente(entrada.userId)));
  if (!p || p.desafioId !== entrada.desafioId) return { cancelada: false };
  if (await reciboDoDesafio(entrada.desafioId, store)) return { cancelada: false };
  await store.del(kPendente(entrada.userId));
  return { cancelada: true };
}

/** Limpeza depois do desafio consumido. Só conveniência: os TTLs apagam de qualquer forma. */
export async function limparRecompensa(desafioId: string, userId: string, store: ArmazemDeRecompensa = getRedis()): Promise<void> {
  const p = lerJson<{ desafioId?: unknown }>(await store.get(kPendente(userId)));
  if (p && p.desafioId === desafioId) await store.del(kPendente(userId)); // nunca apaga o pendente de outro desafio
  await store.del(kModo(desafioId));
  await store.del(kRecibo(desafioId));
}

// ── Callback ─────────────────────────────────────────────────────────────────

/** `md5(timestamp + eventId + userId(decodificado) + rewards + chave)`, como na doc oficial. */
export function assinaturaDoEvento(c: { timestamp: string; eventId: string; userId: string; rewards: string }, chave: string): string {
  return crypto.createHash("md5").update(`${c.timestamp}${c.eventId}${c.userId}${c.rewards}${chave}`).digest("hex");
}

function assinaturaConfere(recebida: string, esperada: string): boolean {
  if (!/^[0-9a-fA-F]{32}$/.test(recebida)) return false;
  return crypto.timingSafeEqual(Buffer.from(recebida.toLowerCase()), Buffer.from(esperada));
}

function instanteDoTimestamp(ts: string): number | null {
  if (!/^\d{12}$/.test(ts)) return null;
  const [a, m, d, h, mi] = [ts.slice(0, 4), ts.slice(4, 6), ts.slice(6, 8), ts.slice(8, 10), ts.slice(10, 12)].map(Number);
  const t = Date.UTC(a, m - 1, d, h, mi);
  return Number.isNaN(t) ? null : t;
}

export interface ResultadoDoCallback {
  status: number;
  /** Corpo da resposta. Só o ACK `EVENT_ID:OK` faz o LevelPlay parar de repetir. */
  corpo: string;
  ack: boolean;
  /** Código estável para o log (nunca valores recebidos). */
  motivo?: string;
}

/**
 * Identidade fixa do "Callback test" do painel do LevelPlay. Só existe onde `LEVELPLAY_S2S_TESTE_USER_ID` está definida
 * (hoje: só o Preview desta branch). Um evento com esse USER_ID **não** passa pelo fluxo real: não consulta contas,
 * não reserva evento e não grava recibo, então nunca pode virar concessão. Continua exigindo assinatura válida, IP oficial
 * e o App Key; só dispensa o `dynamicUserId` e o desafio, que um teste sintético não tem.
 */
export function idDeTesteSintetico(env: Env = process.env): string | null {
  const id = env.LEVELPLAY_S2S_TESTE_USER_ID;
  return typeof id === "string" && HEX32.test(id) ? id : null;
}

const recusa = (status: number, corpo: string): ResultadoDoCallback => ({ status, corpo, ack: false });

/**
 * Valida e persiste o evento. **ACK só depois de persistir** (evento reservado + recibo gravado); qualquer
 * falha de armazenamento é 503 sem ACK e o LevelPlay repete. Quatro acessos ao armazenamento no caminho feliz
 * (o LevelPlay espera resposta em 400 ms). Nada aqui emite concessão.
 */
export async function processarCallbackLevelPlay(
  entrada: { query: URLSearchParams; ip: string; agora: number; env?: Env },
  store: ArmazemDeRecompensa = getRedis(),
): Promise<ResultadoDoCallback> {
  const r = await decidirCallback(entrada, store);
  try {
    // Só nomes de parâmetros e o motivo: nenhum valor (assinatura, ids ou chave) vai para o log.
    const nomes = Array.from(new Set(Array.from(entrada.query.keys()))).slice(0, 20).map((n) => n.slice(0, 40)).sort();
    console.log(JSON.stringify({ evento: "levelplay_callback", status: r.status, ack: r.ack, motivo: r.motivo ?? (r.ack ? "ok" : r.corpo), parametros: nomes }));
  } catch {
    /* log nunca derruba a resposta */
  }
  return r;
}

async function decidirCallback(
  entrada: { query: URLSearchParams; ip: string; agora: number; env?: Env },
  store: ArmazemDeRecompensa,
): Promise<ResultadoDoCallback> {
  const env = entrada.env ?? process.env;
  if (!receptorS2sAtivo(env)) return recusa(404, "indisponivel");
  const chave = chavePrivadaS2s(env);
  if (!chave) return recusa(503, "nao configurado");
  if (conferirIpDoLevelPlay(env) && !IPS_DO_LEVELPLAY.includes(entrada.ip)) return recusa(403, "origem nao permitida");

  const unico = (nome: string): string | null => {
    const v = entrada.query.getAll(nome);
    return v.length === 1 && v[0] !== "" ? v[0] : null;
  };
  const lpUid = unico("applicationUserId");
  const eventId = unico("eventId");
  const rewards = unico("rewards");
  const timestamp = unico("timestamp");
  const signature = unico("signature");
  const dynamicUserId = unico("dynamicUserId");
  // Teste sintético do painel (ver `idDeTesteSintetico`): assinatura, IP e App Key valem; nada é gravado.
  const idDeTeste = idDeTesteSintetico(env);
  if (idDeTeste && lpUid === idDeTeste) {
    const appKeyDoTeste = appKeyEsperada(env);
    if (appKeyDoTeste && unico("appKey") !== appKeyDoTeste) return recusa(400, "app desconhecido");
    if (!eventId || !rewards || !timestamp || !signature) return recusa(400, "teste sintetico: parametros ausentes");
    if (!/^[A-Za-z0-9]{1,128}$/.test(eventId) || !/^[1-9]\d{0,5}$/.test(rewards)) return recusa(400, "teste sintetico: parametros invalidos");
    if (!assinaturaConfere(signature, assinaturaDoEvento({ timestamp, eventId, userId: lpUid, rewards }, chave))) {
      return recusa(403, "assinatura invalida");
    }
    const instante = instanteDoTimestamp(timestamp);
    if (instante === null || Math.abs(entrada.agora - instante) > JANELA_TIMESTAMP_MS) return recusa(400, "timestamp invalido");
    return { status: 200, corpo: `${eventId}:OK`, ack: true, motivo: "teste_sintetico_ok" };
  }

  if (!lpUid || !eventId || !rewards || !timestamp || !signature || !dynamicUserId) return recusa(400, "parametros invalidos");
  // Opcional (`appKey=[APP_KEY]` na URL do painel): um app ou ambiente que reaproveite este callback é recusado.
  const appKey = appKeyEsperada(env);
  if (appKey && unico("appKey") !== appKey) return recusa(400, "app desconhecido");
  if (!HEX32.test(lpUid) || !HEX48.test(dynamicUserId) || !/^[A-Za-z0-9]{1,128}$/.test(eventId) || !/^[1-9]\d{0,5}$/.test(rewards)) {
    return recusa(400, "parametros invalidos");
  }

  if (!assinaturaConfere(signature, assinaturaDoEvento({ timestamp, eventId, userId: lpUid, rewards }, chave))) {
    return recusa(403, "assinatura invalida");
  }
  const quando = instanteDoTimestamp(timestamp);
  if (quando === null || Math.abs(entrada.agora - quando) > JANELA_TIMESTAMP_MS) return recusa(400, "timestamp invalido");

  try {
    // 1. a conta, pela identidade assinada (em paralelo com a consulta de reentrega)
    const [userId, donoDoEvento] = await Promise.all([store.get(kIdentidadeReversa(lpUid)), store.get(kEvento(eventId))]);
    if (!userId) return recusa(400, "identidade desconhecida");
    const pendente = lerJson<{ desafioId?: unknown; nonce?: unknown }>(await store.get(kPendente(userId)));

    // Reentrega de um evento já processado (o ACK pode ter passado de 400 ms ou se perdido): reconhece sem
    // novo recibo, mesmo depois de o desafio ter sido consumido. Só não reconhece se ficou pela metade
    // (evento reservado, recibo ainda não gravado, desafio ainda pendente): aí segue e completa.
    if (donoDoEvento) {
      const pela_metade = pendente?.desafioId === donoDoEvento && (await reciboDoDesafio(donoDoEvento, store)) === null;
      if (!pela_metade) return { status: 200, corpo: `${eventId}:OK`, ack: true };
    }

    // 2. o único desafio pendente dela, confirmado pelo segredo do dynamicUserId
    if (!pendente || typeof pendente.desafioId !== "string" || typeof pendente.nonce !== "string" || !iguais(pendente.nonce, dynamicUserId)) {
      return recusa(409, "sem desafio pendente correspondente");
    }
    const desafioId = pendente.desafioId;

    // O evento é reservado primeiro: um evento nunca serve a dois desafios, mesmo repetido.
    const reservou = await store.set(kEvento(eventId), desafioId, { ex: TTL_EVENTO_S, nx: true });
    if (!reservou && (await store.get(kEvento(eventId))) !== desafioId) return recusa(409, "evento ja usado");

    // Um segundo evento para o mesmo desafio é reconhecido e ignorado: o primeiro recibo vale.
    await store.set(kRecibo(desafioId), JSON.stringify({ eventId, em: entrada.agora }), { ex: TTL_RECIBO_S, nx: true });
    return { status: 200, corpo: `${eventId}:OK`, ack: true };
  } catch {
    return recusa(503, "indisponivel");
  }
}
