/**
 * Reescrita de manifesto HLS — a peça que faz o upstream não sair daqui.
 *
 * Módulo **puro e sem dependência nenhuma**, nem de Node, nem do Next. Isso é
 * requisito, não estilo: o mesmo arquivo é compilado dentro do Cloudflare
 * Worker (`workers/media-proxy`) e exercitado pelos testes do backend. Uma
 * segunda implementação da reescrita seria uma segunda chance de deixar uma URL
 * absoluta passar.
 *
 * ## O que a reescrita precisa cobrir
 *
 * Não basta trocar as linhas de segmento. Um manifesto HLS aponta para fora em
 * mais lugares do que parece, e qualquer um deles esquecido vaza o CDN real:
 *
 *   - linha nua de segmento ou de variante;
 *   - `#EXT-X-KEY:URI="…"` e `#EXT-X-SESSION-KEY:URI="…"` (a chave AES);
 *   - `#EXT-X-MAP:URI="…"` (o cabeçalho de inicialização do fMP4);
 *   - `#EXT-X-MEDIA:…,URI="…"` (áudio e legenda alternativos);
 *   - `#EXT-X-PART:…,URI="…"` e `#EXT-X-PRELOAD-HINT:…,URI="…"` (LL-HLS);
 *   - `#EXT-X-I-FRAME-STREAM-INF:…,URI="…"`.
 *
 * O provider medido na Fase A usa só o primeiro caso — e serve os segmentos
 * como `.css`, de outro host, para atravessar filtro. Os demais estão aqui
 * porque o custo de cobri-los agora é uma linha cada, e o custo de descobri-los
 * depois é um vazamento em produção.
 *
 * ## O modelo de URL pública
 *
 *   <base do edge>/canal/<sessionId>/s/<idDaBase>/<caminho+query>?e=<exp>&k=<sig>
 *
 * `<idDaBase>` é opaco e **determinístico**: `HMAC(chave, base)` truncado. Não é
 * mais um índice em vetor, e a diferença importa — ver `assinatura.ts`.
 *
 * ## Quem persiste é quem chama
 *
 * Esta função **não escreve em lugar nenhum**: ela devolve, em `basesUsadas`,
 * todas as bases que o manifesto reescrito passou a referenciar. Quem chama
 * precisa garantir que cada uma esteja persistida **antes** de servir o
 * resultado — senão o manifesto sai apontando para um id que ninguém consegue
 * resolver, e todo segmento dele responde 403.
 */

import { empacotarRecurso, mesmaOrigem } from "./assinatura";

/** Assina um recurso. Assíncrona porque no Worker o HMAC é WebCrypto. */
export type Assinador = (escopo: "m" | "s", recurso: string, exp: number) => Promise<string>;

/** Calcula o id opaco de uma base. Assíncrona pelo mesmo motivo. */
export type IdentificadorDeBase = (base: string) => Promise<string>;

export interface EntradaDeReescrita {
  /** O manifesto como veio do upstream. */
  manifesto: string;
  /** URL absoluta de onde ele veio, para resolver referência relativa. */
  urlDoManifesto: string;
  sessionId: string;
  /** Prefixo público do edge, sem barra final. Ex.: `https://media.exemplo` */
  baseDoEdge: string;
  expSegmento: number;
  expManifesto: number;
  assinar: Assinador;
  idDaBase: IdentificadorDeBase;
}

export interface SaidaDeReescrita {
  manifesto: string;
  /**
   * Toda base referenciada pelo manifesto reescrito, com o id de cada.
   *
   * Quem chama tem de persistir todas antes de servir. Não há "novas" e
   * "conhecidas" aqui de propósito: este módulo não sabe o que está no Redis, e
   * inventar esse palpite seria a forma mais fácil de servir um manifesto cuja
   * base ninguém gravou.
   */
  basesUsadas: { id: string; base: string }[];
}

/** `true` para linha de tag; `false` para URI nua e para linha vazia. */
function ehTag(linha: string): boolean {
  return linha.startsWith("#");
}

/**
 * Separa uma URI absoluta em base (tudo até a última barra do caminho,
 * inclusive) e o resto — caminho final **mais query e fragmento**.
 *
 * A query fica do lado que viaja, e não do lado escondido, porque ela pode
 * variar por segmento (`?token=…`): se entrasse na base, cada segmento criaria
 * uma base nova, e o teto de `MAX_BASES` estouraria no primeiro provider que
 * assinasse segmento.
 */
function partir(absoluta: string): { base: string; caminho: string } | null {
  let u: URL;
  try {
    u = new URL(absoluta);
  } catch {
    return null;
  }
  const corte = u.pathname.lastIndexOf("/");
  if (corte < 0) return null;
  const base = `${u.origin}${u.pathname.slice(0, corte + 1)}`;
  const caminho = `${u.pathname.slice(corte + 1)}${u.search}${u.hash}`;
  return { base, caminho };
}

/**
 * Teto de bases distintas num manifesto.
 *
 * Um manifesto legítimo usa uma ou duas. O teto existe porque um upstream
 * hostil poderia listar milhares de hosts distintos e transformar uma resposta
 * em milhares de gravações no Redis — e porque, passando disso, algo está
 * errado e falhar é melhor que servir.
 */
const MAX_BASES = 8;

/** `.m3u8` (ou `.m3u`) — manifesto filho, que precisa de reescrita própria. */
function ehManifesto(caminho: string): boolean {
  return /\.m3u8?(\?|#|$)/i.test(caminho);
}

export async function reescreverManifesto(e: EntradaDeReescrita): Promise<SaidaDeReescrita> {
  const baseDoEdge = e.baseDoEdge.replace(/\/+$/, "");
  /** base → id, memoizado: o mesmo manifesto repete a base em toda linha. */
  const idsPorBase = new Map<string, string>();

  /** Uma URI do upstream vira uma URI do edge. `null` quando não dá. */
  async function publica(refBruta: string): Promise<string | null> {
    const ref = refBruta.trim();
    if (!ref) return null;
    let absoluta: string;
    try {
      absoluta = new URL(ref, e.urlDoManifesto).toString();
    } catch {
      return null;
    }
    if (!absoluta.startsWith("https://")) return null;

    const partes = partir(absoluta);
    if (!partes) return null;

    let id = idsPorBase.get(partes.base);
    if (id === undefined) {
      if (idsPorBase.size >= MAX_BASES) return null;
      id = await e.idDaBase(partes.base);
      idsPorBase.set(partes.base, id);
    }

    // Um manifesto filho é buscado pelo edge de novo e reescrito de novo, então
    // ganha o escopo e a validade de manifesto. Um segmento é buscado uma vez e
    // ganha a validade curta.
    const escopo: "m" | "s" = ehManifesto(partes.caminho) ? "m" : "s";
    const exp = escopo === "m" ? e.expManifesto : e.expSegmento;
    const recurso = empacotarRecurso(id, partes.caminho);
    const sig = await e.assinar(escopo, recurso, exp);
    const rota = escopo === "m" ? "v" : "s";
    // `recurso` já é um segmento único e percent-encodado, então a única query
    // da URL resultante é a nossa.
    return `${baseDoEdge}/canal/${e.sessionId}/${rota}/${recurso}?e=${exp}&k=${sig}`;
  }

  /** Reescreve o valor de `URI="…"` dentro de uma tag, preservando o resto. */
  async function reescreverAtributoUri(linha: string): Promise<string> {
    const m = /URI="([^"]*)"/i.exec(linha);
    if (!m) return linha;
    const nova = await publica(m[1]);
    // Sem substituto seguro, a tag inteira sai. Devolver a original seria
    // publicar o host do upstream — exatamente o que este módulo evita.
    if (!nova) return "";
    return linha.slice(0, m.index) + `URI="${nova}"` + linha.slice(m.index + m[0].length);
  }

  const TAGS_COM_URI =
    /^#EXT-X-(?:KEY|SESSION-KEY|MAP|MEDIA|PART|PRELOAD-HINT|I-FRAME-STREAM-INF|RENDITION-REPORT):/i;

  const saida: string[] = [];
  for (const linha of e.manifesto.split(/\r?\n/)) {
    if (!linha.trim()) {
      saida.push(linha);
      continue;
    }
    if (ehTag(linha)) {
      saida.push(TAGS_COM_URI.test(linha) ? await reescreverAtributoUri(linha) : linha);
      continue;
    }
    const nova = await publica(linha);
    // Linha de mídia sem substituto seguro é descartada, não repassada.
    if (nova) saida.push(nova);
  }

  return {
    manifesto: saida.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"),
    basesUsadas: [...idsPorBase].map(([base, id]) => ({ id, base })),
  };
}

/**
 * `true` se o texto ainda contém URL absoluta que não seja do edge.
 *
 * Rede de segurança do teste e do próprio edge: a reescrita acima é feita por
 * lista de tags conhecidas, e lista de tags conhecidas envelhece. Esta checagem
 * não envelhece — ela pergunta o que realmente importa, que é se sobrou host de
 * terceiro no que vai sair.
 *
 * A comparação é por **origem**, e não por prefixo de string. `startsWith`
 * aceita `https://media.exemplo.evil.example` quando a base é
 * `https://media.exemplo`: o host hostil vem depois, e o prefixo casa. Origem é
 * esquema + host + porta, e não tem essa falha.
 */
export function vazaUpstream(manifesto: string, baseDoEdge: string): boolean {
  const urls = manifesto.match(/https?:\/\/[^\s"',]+/gi);
  if (!urls) return false;
  return urls.some((u) => !mesmaOrigem(u, baseDoEdge));
}
