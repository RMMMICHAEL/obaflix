import { getRedis } from "./redis";
import type { EstrategiaCoordenada } from "./episodeCoordinates";

/**
 * Qual estratégia de coordenada já resolveu um tmdbId em cada provedor.
 *
 * Otimização, nunca fonte de verdade: só reordena as tentativas, a canônica
 * continua na lista e a identidade do episódio não passa por aqui. Guarda a
 * ESTRATÉGIA (não URL nem coordenada): a regra é recalculada por episódio, e o
 * que valeu para T2E1 vale para T2E2.
 *
 * Uma chave por título, com o mapa dos provedores dentro: a sessão de fontes
 * paga um GET só, em vez de um por provedor. A escrita só acontece quando a
 * primeira tentativa falhou e outra funcionou — reprodução normal não escreve.
 *
 * Redis fora do ar, chave ausente, valor corrompido: tudo vira "não sei", sem
 * erro. A reprodução não depende disto.
 */

const TTL_SEC = 7 * 24 * 60 * 60;
const VALIDAS: ReadonlySet<string> = new Set(["canonical", "continuous", "alias"]);

const chave = (tmdbId: string) => `epcoord:v1:${tmdbId}`;

export type MapaAprendido = Partial<Record<string, EstrategiaCoordenada>>;

function normalizar(bruto: unknown): MapaAprendido {
  let obj: unknown = bruto;
  if (typeof bruto === "string") {
    try { obj = JSON.parse(bruto); } catch { return {}; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const saida: MapaAprendido = {};
  for (const [provider, valor] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof valor === "string" && VALIDAS.has(valor)) saida[provider] = valor as EstrategiaCoordenada;
  }
  return saida;
}

export async function lerAprendidas(tmdbId: string): Promise<MapaAprendido> {
  if (!/^\d{1,12}$/.test(tmdbId)) return {};
  try {
    return normalizar(await getRedis().get(chave(tmdbId)));
  } catch {
    return {};
  }
}

/**
 * Registra o que funcionou. `canonical` apaga a entrada do provedor: é o
 * padrão, não precisa ser lembrado. Corrida entre duas escritas perde no
 * máximo uma dica — a próxima reprodução reaprende.
 */
export async function aprenderEstrategia(
  tmdbId: string,
  provider: string,
  estrategia: EstrategiaCoordenada,
): Promise<void> {
  if (!/^\d{1,12}$/.test(tmdbId) || !VALIDAS.has(estrategia)) return;
  try {
    const redis = getRedis();
    const atual = normalizar(await redis.get(chave(tmdbId)));
    if (estrategia === "canonical") {
      if (!(provider in atual)) return;
      delete atual[provider];
    } else {
      if (atual[provider] === estrategia) return;
      atual[provider] = estrategia;
    }
    if (Object.keys(atual).length === 0) await redis.del(chave(tmdbId));
    else await redis.set(chave(tmdbId), JSON.stringify(atual), { ex: TTL_SEC });
  } catch {
    // Dica perdida não é erro.
  }
}
