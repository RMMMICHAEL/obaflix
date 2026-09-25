/**
 * Resolução server-side de um canal: da página do player até a URL de mídia.
 *
 * ## O que a Fase A descobriu, e o que isso obriga
 *
 * O provider não exige `Referer`, nem `User-Agent`, nem cookie. O que ele exige
 * é **ordem**: o manifesto responde 403 até que a página do player tenha sido
 * buscada, e a partir daí responde 200 para qualquer requisição — inclusive sem
 * cabeçalho nenhum, de outro processo. O estado fica no servidor do provider,
 * por par (IP, canal). Chamamos isso de *arm*.
 *
 * **A URL de mídia é descoberta transitória, não fonte de verdade.** A
 * identidade estável do canal é `player_url`/`providerChannelId` — o `.m3u8`
 * pode mudar/rotacionar de um momento para o outro, ou depender de o player ter
 * sido aberto antes. A string capturada num instante **não** é garantia de valer
 * no próximo. Por isso a resolução busca **sempre** a página do player e extrai
 * a mídia atual; e por isso o edge, quando a mídia falha, re-resolve para
 * descobrir a URL nova (ver `workers/media-proxy/src/canais.ts`).
 *
 * O que isso decide no desenho:
 *
 *   - a URL nunca vai para o cliente: **esconder é a proteção** — entregá-la
 *     seria entregar (enquanto valesse) o acesso ao canal;
 *   - o grant é por IP, então **quem arma tem de ser quem busca** — este módulo
 *     resolve, mas quem arma de verdade é o edge, no egress dele.
 *
 * Por isso este arquivo **descobre** a URL e não a serve, e por isso o *arm*
 * daqui é só um efeito colateral de descobrir: o grant que ele cria é para o IP
 * da Vercel, que não vai reproduzir nada.
 *
 * O resultado nunca vira cadastro. `CanalFonte` não guarda `.m3u8` de
 * propósito: persistir uma mídia transitória seria tratar como permanente algo
 * que rotaciona — e é justamente o que este módulo (e o edge) existem para não
 * fazer. No banco fica só `provider` + `providerChannelId`.
 */

import { assertSafeUrl } from "../ssrf";
import {
  hostDeMidiaPermitido,
  hostDoPlayer,
  montarUrlDoPlayer,
  type ProviderDeCanal,
} from "./providers";

/**
 * O resultado interno da resolução. **Não é DTO público** e não tem forma de
 * chegar a um cliente: quem o recebe é a sessão no Redis, que o edge lê pelo id
 * opaco.
 *
 * Não há campo de cookie, e não deve passar a haver. Se um provider futuro
 * exigir sessão, o cookie jar fica no componente que faz a requisição — nunca
 * atravessa um DTO, nem mesmo um interno.
 */
export interface FonteDeCanalResolvida {
  streamUrl: string;
  /** A página que arma o grant. O edge busca esta URL antes da mídia. */
  paginaDoPlayer: string;
  /** `null` quando o provider não exige, que é o caso medido na Fase A. */
  referer: string | null;
  userAgent: string | null;
  /**
   * `null` porque o provider não devolve um instante de expiração — não porque a
   * URL seja permanente. A rotação é tratada de forma **reativa** no edge (quando
   * a mídia falha, re-resolve), e não por um relógio: inventar um `expiresAt`
   * aqui só criaria re-resoluções no horário errado — cedo demais, desperdício;
   * tarde demais, não ajuda. Quem sabe que a URL morreu é o upstream, com um erro.
   */
  expiresAt: number | null;
}

export class FalhaNaResolucao extends Error {
  constructor(
    readonly motivo:
      | "pagina_indisponivel"
      | "midia_nao_encontrada"
      | "midia_recusada"
      | "provider_invalido",
    detalhe?: string,
  ) {
    super(`resolução falhou: ${motivo}${detalhe ? ` (${detalhe})` : ""}`);
    this.name = "FalhaNaResolucao";
  }
}

/**
 * UA de navegador, e não o nosso.
 *
 * Não é disfarce por esporte: a página do player é servida por PHP que decide o
 * corpo pelo UA, e um UA desconhecido já foi observado devolvendo variante sem
 * a configuração do player. É o único cabeçalho que este módulo insiste em
 * mandar.
 */
const UA_DE_RESOLUCAO =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TIMEOUT_MS = 12_000;

/**
 * Teto de leitura da página do player. As 136 páginas medidas na Fase A ficam
 * abaixo de 8 KB; 512 KB é folga de duas ordens de grandeza e ainda impede que
 * um upstream hostil (ou comprometido) transforme a resolução em consumo de
 * memória da função serverless.
 */
const MAX_BYTES_DA_PAGINA = 512 * 1024;

/**
 * Lê no máximo `MAX_BYTES_DA_PAGINA` e **cancela o corpo** ao estourar.
 *
 * `await response.text()` não tem teto: um `Content-Length` mentiroso ou um
 * corpo em streaming infinito derrubaria a função antes de qualquer validação.
 */
async function lerComTeto(res: Response): Promise<string> {
  const corpo = res.body;
  if (!corpo) return "";
  const leitor = corpo.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES_DA_PAGINA) {
        await leitor.cancel().catch(() => {});
        break;
      }
      partes.push(value);
    }
  } finally {
    leitor.releaseLock();
  }
  const juntas = new Uint8Array(partes.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of partes) {
    juntas.set(p, offset);
    offset += p.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(juntas);
}

// A extração vive em `./extracao.ts` — puro e sem Node — para o edge poder
// reusá-la na re-resolução por rotação. Reexportado aqui para não quebrar quem
// já importa de `resolver`.
export { extrairCandidatosDeMidia } from "./extracao";
import { extrairCandidatosDeMidia } from "./extracao";

/**
 * Aceita um candidato só se ele passar por **três** portas independentes:
 * HTTPS, allowlist de host de CDN, e a validação anti-SSRF (que resolve o DNS e
 * recusa faixa interna, incluindo rebinding).
 *
 * A allowlist não é redundante com o SSRF: SSRF impede falar com a nossa rede,
 * a allowlist impede falar com qualquer host da internet que um player
 * comprometido resolva apontar.
 */
async function aceitarCandidato(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = await assertSafeUrl(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!hostDeMidiaPermitido(parsed.hostname)) return null;
  return parsed.toString();
}

/**
 * Busca a página do player e devolve a mídia atual do canal.
 *
 * Efeito colateral deliberado: a requisição arma o grant do provider para o IP
 * de quem chamou. Aqui isso não tem serventia (quem reproduz é o edge) — está
 * documentado para ninguém "otimizar" um cache que pule esta requisição e
 * depois não entenda o 403.
 */
export async function resolverCanal(
  provider: ProviderDeCanal,
  providerChannelId: string,
): Promise<FonteDeCanalResolvida> {
  let paginaDoPlayer: string;
  try {
    paginaDoPlayer = montarUrlDoPlayer(provider, providerChannelId);
  } catch {
    throw new FalhaNaResolucao("provider_invalido");
  }

  // A própria página do player passa pelo SSRF. O host vem do nosso registro,
  // mas `CANAIS_PLAYER_HOST` é ambiente, e ambiente é entrada.
  const alvo = await assertSafeUrl(paginaDoPlayer).catch(() => null);
  if (!alvo || alvo.protocol !== "https:" || alvo.hostname.toLowerCase() !== hostDoPlayer(provider).toLowerCase()) {
    throw new FalhaNaResolucao("provider_invalido");
  }

  const sinal = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    // `redirect: "manual"`: seguir redirect sairia da allowlist sem revalidar.
    // A Fase A não observou redirect nenhum nas 136 páginas; se aparecer um, o
    // certo é falhar visivelmente e revisar, não segui-lo em silêncio.
    res = await fetch(alvo, {
      method: "GET",
      redirect: "manual",
      signal: sinal,
      headers: { "User-Agent": UA_DE_RESOLUCAO, Accept: "text/html,*/*" },
    });
  } catch {
    throw new FalhaNaResolucao("pagina_indisponivel", "rede");
  }

  if (res.status !== 200) {
    res.body?.cancel().catch(() => {});
    throw new FalhaNaResolucao("pagina_indisponivel", `http ${res.status}`);
  }

  const html = await lerComTeto(res);
  const candidatos = extrairCandidatosDeMidia(html);
  if (candidatos.length === 0) throw new FalhaNaResolucao("midia_nao_encontrada");

  for (const candidato of candidatos) {
    const aceito = await aceitarCandidato(candidato);
    if (aceito) {
      return {
        streamUrl: aceito,
        paginaDoPlayer: alvo.toString(),
        referer: null,
        userAgent: null,
        expiresAt: null,
      };
    }
  }
  throw new FalhaNaResolucao("midia_recusada", `${candidatos.length} candidato(s) fora da allowlist`);
}
