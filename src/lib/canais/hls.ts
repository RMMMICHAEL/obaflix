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
 *   <base do edge>/canal/<sessionId>/s/<i>/<caminho>?e=<exp>&k=<sig>
 *
 * `<i>` é o índice da base upstream dentro da sessão (Redis), não o host. O
 * cliente vê um número e um nome de arquivo; o domínio real fica no servidor.
 */

/** Assina um recurso. Assíncrona porque no Worker o HMAC é WebCrypto. */
export type Assinador = (escopo: "m" | "s", recurso: string, exp: number) => Promise<string>;

export interface EntradaDeReescrita {
  /** O manifesto como veio do upstream. */
  manifesto: string;
  /** URL absoluta de onde ele veio, para resolver referência relativa. */
  urlDoManifesto: string;
  sessionId: string;
  /** Prefixo público do edge, sem barra final. Ex.: `https://media.exemplo` */
  baseDoEdge: string;
  /** Bases já conhecidas da sessão. A reescrita pode acrescentar. */
  basesConhecidas: string[];
  expSegmento: number;
  expManifesto: number;
  assinar: Assinador;
}

export interface SaidaDeReescrita {
  manifesto: string;
  /** As bases após a reescrita. Se mudou, a sessão precisa ser regravada. */
  bases: string[];
  /** `true` se `bases` ganhou entrada nova — evita escrever no Redis à toa. */
  basesMudaram: boolean;
}

/** `true` para linha de tag; `false` para URI nua e para linha vazia. */
function ehTag(linha: string): boolean {
  return linha.startsWith("#");
}

/**
 * Separa uma URI absoluta em base (tudo até a última barra, inclusive) e
 * caminho restante. A base é o que fica escondido; o caminho é o que viaja.
 */
function partir(absoluta: string): { base: string; caminho: string } {
  const corte = absoluta.lastIndexOf("/");
  return { base: absoluta.slice(0, corte + 1), caminho: absoluta.slice(corte + 1) };
}

/**
 * Índice da base, acrescentando se for nova.
 *
 * Um manifesto legítimo usa uma ou duas bases. O teto existe porque um upstream
 * hostil poderia listar milhares de hosts distintos e inflar a sessão no Redis
 * — e porque, passando disso, algo está errado e falhar é melhor que servir.
 */
const MAX_BASES = 8;

function indiceDaBase(bases: string[], base: string): number {
  const i = bases.indexOf(base);
  if (i >= 0) return i;
  if (bases.length >= MAX_BASES) return -1;
  bases.push(base);
  return bases.length - 1;
}

/** `.m3u8` (ou `.m3u`) — manifesto filho, que precisa de reescrita própria. */
function ehManifesto(caminho: string): boolean {
  return /\.m3u8?(\?|$)/i.test(caminho);
}

export async function reescreverManifesto(e: EntradaDeReescrita): Promise<SaidaDeReescrita> {
  const bases = [...e.basesConhecidas];
  const antes = bases.length;

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

    const { base, caminho } = partir(absoluta);
    const i = indiceDaBase(bases, base);
    if (i < 0) return null;

    // Um manifesto filho é buscado pelo edge de novo e reescrito de novo, então
    // ganha o escopo e a validade de manifesto. Um segmento é buscado uma vez e
    // ganha os cinco minutos.
    const escopo: "m" | "s" = ehManifesto(caminho) ? "m" : "s";
    const exp = escopo === "m" ? e.expManifesto : e.expSegmento;
    const recurso = `${i}/${caminho}`;
    const sig = await e.assinar(escopo, recurso, exp);
    const rota = escopo === "m" ? "v" : "s";
    return `${e.baseDoEdge}/canal/${e.sessionId}/${rota}/${recurso}${caminho.includes("?") ? "&" : "?"}e=${exp}&k=${sig}`;
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
    bases,
    basesMudaram: bases.length !== antes,
  };
}

/**
 * `true` se o texto ainda contém URL absoluta http(s) que não seja do edge.
 *
 * Rede de segurança do teste e do próprio edge: a reescrita acima é feita por
 * lista de tags conhecidas, e lista de tags conhecidas envelhece. Esta checagem
 * não envelhece — ela pergunta o que realmente importa, que é se sobrou host de
 * terceiro no que vai sair.
 */
export function vazaUpstream(manifesto: string, baseDoEdge: string): boolean {
  const urls = manifesto.match(/https?:\/\/[^\s"',]+/gi);
  if (!urls) return false;
  return urls.some((u) => !u.startsWith(baseDoEdge));
}
