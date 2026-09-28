import { totalTentativas, urlDaTentativa, type FonteReal } from "./fontes";
import { rotuloCoordenada, type EstrategiaCoordenada } from "./episodeCoordinates";
import { aprenderEstrategia } from "./episodeCoordinateCache";

/**
 * Executa as tentativas de coordenada de UMA fonte, em ordem, até a primeira
 * que o chamador considerar reproduzível. Quem decide o que é sucesso é o
 * chamador, com a mesma regra que já usava — aqui não existe uma segunda
 * definição de "vídeo válido".
 *
 * Finito por construção: no máximo `totalTentativas` chamadas (≤ 4), nunca a
 * mesma URL duas vezes, nunca recursivo. Tudo falhando, devolve o último
 * resultado (ou relança o último erro) exatamente como a tentativa única faria
 * — e o fallback para o próximo servidor segue como hoje.
 *
 * Log por tentativa sem URL, host nem token:
 *   [coord] tmdbId=… provider=… canonical=T2E1 attempt=T1E27 strategy=continuous result=success
 */

type FonteComCoordenadas = Pick<FonteReal, "embedUrl" | "provider" | "coordenadas">;

export interface ResultadoTentativas<R> {
  resultado: R | null;
  /** URL que produziu `resultado` — a que funcionou, ou a última tentada. */
  url: string;
  estrategia: EstrategiaCoordenada;
  tentadas: number;
}

export async function executarTentativas<R>(opts: {
  fonte: FonteComCoordenadas;
  /** Coordenada canônica, só para o log. */
  canonica?: { season: number; episode: number } | null;
  tentar: (url: string) => Promise<R>;
  sucesso: (r: R) => boolean;
  /** Para de tentar (ex.: prazo global esgotado). */
  cancelado?: () => boolean;
  log?: (linha: string) => void;
  aprender?: typeof aprenderEstrategia;
}): Promise<ResultadoTentativas<R>> {
  const { fonte } = opts;
  const total = totalTentativas(fonte);
  const log = opts.log ?? ((linha: string) => console.log(linha));
  const aprender = opts.aprender ?? aprenderEstrategia;
  const tentadasUrls = new Set<string>();

  let ultimo: R | null = null;
  let ultimoErro: unknown = undefined;
  let ultimaFoiErro = false;
  let ultimaUrl = fonte.embedUrl;
  let ultimaEstrategia: EstrategiaCoordenada = "canonical";

  for (let i = 0; i < total; i++) {
    if (i > 0 && opts.cancelado?.()) break;
    const url = urlDaTentativa(fonte, i);
    if (!url || tentadasUrls.has(url)) continue;
    tentadasUrls.add(url);

    const coord = fonte.coordenadas?.tentativas[i];
    const estrategia: EstrategiaCoordenada = coord?.strategy ?? "canonical";
    ultimaUrl = url;
    ultimaEstrategia = estrategia;

    let ok = false;
    try {
      ultimo = await opts.tentar(url);
      ultimaFoiErro = false;
      ok = opts.sucesso(ultimo);
    } catch (e) {
      ultimoErro = e;
      ultimaFoiErro = true;
      ultimo = null;
    }

    if (fonte.coordenadas && coord) {
      log(
        `[coord] tmdbId=${fonte.coordenadas.tmdbId} provider=${fonte.provider}`
        + (opts.canonica ? ` canonical=${rotuloCoordenada(opts.canonica)}` : "")
        + ` attempt=${rotuloCoordenada(coord)} strategy=${estrategia} ordem=${i + 1}/${total}`
        + ` result=${ok ? "success" : ultimaFoiErro ? "error" : "failed"}`,
      );
    }

    if (ok) {
      // Só aprende quando a primeira tentativa não bastou: reprodução normal
      // não escreve no Redis.
      if (i > 0 && fonte.coordenadas) await aprender(fonte.coordenadas.tmdbId, fonte.provider, estrategia);
      return { resultado: ultimo, url, estrategia, tentadas: tentadasUrls.size };
    }
  }

  if (ultimaFoiErro) throw ultimoErro;
  return { resultado: ultimo, url: ultimaUrl, estrategia: ultimaEstrategia, tentadas: tentadasUrls.size };
}
