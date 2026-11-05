import crypto from "node:crypto";
import { getRedis } from "@/lib/redis";
import {
  JANELA_TIMESTAMP_MS,
  registrarReciboDaRecompensa,
  type ArmazemDeRecompensa,
  type ResultadoDoCallback,
} from "./recompensaLevelPlay";

/**
 * Receptor do AdMob (Rewarded) com verificação do lado do servidor (SSV): `GET /api/ads/admob/ssv`.
 *
 * Prova: assinatura ECDSA (SHA-256) do Google sobre a query até `&signature=`, com a chave pública indicada por `key_id`
 * na lista oficial do Google. Amarras iguais às do LevelPlay, pelo mesmo núcleo (`registrarReciboDaRecompensa`):
 * `user_id` = identidade opaca da conta (32 hex) e `custom_data` = segredo de uso único do desafio (48 hex). Só grava o
 * recibo; a concessão continua em `/api/ads/complete`. Desligado (404) sem `ADMOB_SSV_ATIVO=true`.
 *
 * Limite: o ad unit é conferido contra `ADMOB_SSV_AD_UNITS` (padrão: o Rewarded oficial); formato e APK não são assinados.
 */
type Env = Record<string, string | undefined>;

export const CHAVES_DO_GOOGLE_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
const AD_UNIT_OFICIAL = "6440175364";
const HEX32 = /^[0-9a-f]{32}$/;
const HEX48 = /^[0-9a-f]{48}$/;

export const admobSsvAtivo = (env: Env = process.env) => env.ADMOB_SSV_ATIVO === "true";

export type BuscarChaves = () => Promise<Record<string, string>>;

let cache: { chaves: Record<string, string>; em: number } | null = null;
const TTL_CHAVES_MS = 6 * 60 * 60 * 1000;
const PAUSA_REBUSCA_MS = 60 * 1000;

/** `key_id` → PEM, da lista oficial. Em cache; uma rebusca (no máximo 1 por minuto) quando o `key_id` ainda não existe. */
export async function chavesDoGoogle(forcar = false, agora = Date.now()): Promise<Record<string, string>> {
  if (cache && !forcar && agora - cache.em < TTL_CHAVES_MS) return cache.chaves;
  if (cache && forcar && agora - cache.em < PAUSA_REBUSCA_MS) return cache.chaves;
  const r = await fetch(CHAVES_DO_GOOGLE_URL, { signal: AbortSignal.timeout(4000), cache: "no-store" });
  if (!r.ok) throw new Error("chaves indisponiveis");
  const json = (await r.json()) as { keys?: Array<{ keyId?: number | string; pem?: string }> };
  const chaves: Record<string, string> = {};
  for (const k of json.keys ?? []) if (k.keyId !== undefined && typeof k.pem === "string") chaves[String(k.keyId)] = k.pem;
  cache = { chaves, em: agora };
  return chaves;
}

export function limparCacheDeChaves() {
  cache = null;
}

/** A assinatura cobre a query exatamente como chegou, do início até antes de `&signature=`. */
export function conteudoAssinado(queryBruta: string): { conteudo: string; assinatura: string; keyId: string } | null {
  const q = queryBruta.startsWith("?") ? queryBruta.slice(1) : queryBruta;
  const i = q.indexOf("&signature=");
  if (i < 0) return null;
  const resto = new URLSearchParams(q.slice(i + 1));
  const assinatura = resto.get("signature");
  const keyId = resto.get("key_id");
  if (!assinatura || !keyId || !/^[A-Za-z0-9_-]{20,200}$/.test(assinatura) || !/^\d{1,20}$/.test(keyId)) return null;
  return { conteudo: q.slice(0, i), assinatura, keyId };
}

export function assinaturaConfere(conteudo: string, assinaturaB64Url: string, pem: string): boolean {
  try {
    return crypto.createVerify("SHA256").update(conteudo).verify(pem, Buffer.from(assinaturaB64Url, "base64url"));
  } catch {
    return false;
  }
}

const recusa = (status: number, corpo: string): ResultadoDoCallback => ({ status, corpo, ack: false });

export async function processarSsvDoAdMob(
  entrada: { queryBruta: string; agora: number; env?: Env; chaves?: (forcar: boolean) => Promise<Record<string, string>> },
  store: ArmazemDeRecompensa = getRedis(),
): Promise<ResultadoDoCallback> {
  const env = entrada.env ?? process.env;
  if (!admobSsvAtivo(env)) return recusa(404, "indisponivel");
  const partes = conteudoAssinado(entrada.queryBruta);
  if (!partes) return recusa(400, "parametros invalidos");

  let pem: string | undefined;
  try {
    const buscar = entrada.chaves ?? ((forcar: boolean) => chavesDoGoogle(forcar, entrada.agora));
    pem = (await buscar(false))[partes.keyId] ?? (await buscar(true))[partes.keyId];
  } catch {
    return recusa(503, "chaves indisponiveis");
  }
  if (!pem) return recusa(403, "chave desconhecida");
  if (!assinaturaConfere(partes.conteudo, partes.assinatura, pem)) return recusa(403, "assinatura invalida");

  // Daqui em diante a query é do Google. Cada parâmetro precisa aparecer exatamente uma vez.
  const q = new URLSearchParams(partes.conteudo);
  const unico = (n: string) => { const v = q.getAll(n); return v.length === 1 && v[0] !== "" ? v[0] : null; };
  const adUnit = unico("ad_unit"), userId = unico("user_id"), customData = unico("custom_data");
  const transacao = unico("transaction_id"), timestamp = unico("timestamp");
  if (!adUnit || !userId || !customData || !transacao || !timestamp) return recusa(400, "parametros invalidos");
  const unidades = (env.ADMOB_SSV_AD_UNITS ?? AD_UNIT_OFICIAL).split(",").map((s) => s.trim()).filter(Boolean);
  if (!unidades.includes(adUnit)) return recusa(403, "ad unit nao permitido");
  if (!HEX32.test(userId) || !HEX48.test(customData) || !/^[A-Za-z0-9]{1,100}$/.test(transacao) || !/^\d{13}$/.test(timestamp)) {
    return recusa(400, "parametros invalidos");
  }
  if (Math.abs(entrada.agora - Number(timestamp)) > JANELA_TIMESTAMP_MS) return recusa(400, "timestamp invalido");

  // O prefixo separa o espaço de eventos do AdMob do do LevelPlay: um id nunca serve aos dois.
  const r = await registrarReciboDaRecompensa(
    { identidade: userId, eventId: `admob${transacao}`, dynamicUserId: customData, agora: entrada.agora },
    store,
  );
  // Assinatura válida mas sem desafio correspondente (inclui o teste do painel do AdMob): reconhece sem gravar recibo.
  // Só falha de armazenamento (503) pede nova entrega.
  if (!r.ack && r.status !== 503) return { status: 200, corpo: "ignorado", ack: false, motivo: r.corpo };
  return r;
}
