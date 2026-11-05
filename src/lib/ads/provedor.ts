import { admobSsvAtivo } from "./admobSsv";

/**
 * Qual rede de anúncios o servidor pede ao aplicativo, por formato. O padrão é o que roda hoje (Unity no Interstitial,
 * LevelPlay no Rewarded): só o valor exato `admob` na variável liga o AdMob, e o Rewarded do AdMob ainda exige o
 * receptor SSV ligado — sem ele a recompensa nunca seria confirmada, então o servidor nem a oferece.
 *
 * Isto só ESCOLHE. O aplicativo ainda exige a build Play, a conta elegível e o consentimento (UMP) antes de tocar no SDK,
 * e a concessão continua em `/api/ads/complete`. Desligar é trocar a variável de volta (vale no próximo pedido).
 */
type Env = Record<string, string | undefined>;

export interface EscolhaDeProvedor {
  interstitial: "unity" | "admob";
  rewarded: "levelplay" | "admob";
}

export function escolherProvedores(env: Env = process.env): EscolhaDeProvedor {
  return {
    interstitial: env.ANUNCIO_PROVEDOR_INTERSTITIAL === "admob" ? "admob" : "unity",
    rewarded: env.ANUNCIO_PROVEDOR_REWARDED === "admob" && admobSsvAtivo(env) ? "admob" : "levelplay",
  };
}
