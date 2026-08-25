// Espelhos do Hide e validação da master playlist — lado Website.
//
// O mesmo comportamento existe em desktop/electron/extractors.js (JavaScript) e
// em android/.../PlayerExtractors.kt (Kotlin). As três implementações são
// tecnicamente diferentes por causa da plataforma; o que precisa ser idêntico é
// o comportamento observável. Ao mudar uma, ajuste as outras duas — ver CLAUDE.md.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/122.0.0.0 Safari/537.36";

/**
 * Espelhos do Hide, em ordem de preferência.
 *
 * playhide.shop era o host canônico e está morto: não completa o TLS, então
 * qualquer requisição morre sem resposta. Fica por último, para o caso de voltar.
 */
export const HIDE_HOSTS = ["hidehide.shop", "vidhidehub.com", "playhide.shop"] as const;

/** Reconhece o host pelo nome exato (ou subdomínio), nunca por substring. */
export function ehHostHide(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return HIDE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * O host da URL recebida vem primeiro: é o que o provedor está anunciando agora,
 * e ignorá-lo foi o que deixou o extrator preso no domínio antigo.
 */
export function ordemEspelhosHide(hostname: string): string[] {
  const host = hostname.toLowerCase();
  const conhecidos = [...HIDE_HOSTS];
  return conhecidos.includes(host as (typeof HIDE_HOSTS)[number])
    ? [host, ...conhecidos.filter((h) => h !== host)]
    : conhecidos;
}

/** Tamanho máximo de manifesto que vale a pena embutir no stream token. */
export const HIDE_MANIFEST_INLINE_MAX = 8 * 1024;

export type VereditoMaster = {
  /** true só quando o CDN provou que o arquivo não existe mais (404/410). */
  removido: boolean;
  /** Corpo da master, quando pequeno o bastante para ir inline no stream token. */
  manifest?: string;
  /** Para log: o que decidiu o veredito. */
  motivo: "removido" | "ok" | "inconclusivo";
  status?: number;
};

/**
 * Confere se o master que a página anunciou existe mesmo no CDN, e reaproveita
 * o corpo quando ele é pequeno.
 *
 * O Hide continua servindo a página e assinando um token válido para arquivos
 * que já saíram do storage: o CDN responde 404 (com token inválido responderia
 * 403). Sem esta checagem a extração "dá certo" e quem descobre o problema é o
 * player, que trava sem dizer por quê.
 *
 * Classificação — a mesma do Electron e do Android:
 *   404/410      → arquivo removido, e só isso conta como removido
 *   403          → token ou autorização, NÃO é arquivo removido
 *   timeout      → nada provado, o stream segue
 *   erro de rede → nada provado, o stream segue
 *
 * O corpo capturado aqui vira `manifest` no stream token e o proxy o serve
 * inline, então a requisição que ele faria ao CDN deixa de acontecer: validar
 * não acrescenta requisição nenhuma no caso comum (master do Hide tem ~1 KB).
 */
export async function validarMasterHide(
  streamUrl: string,
  paginaHide: string,
  timeoutMs = 6000,
): Promise<VereditoMaster> {
  try {
    const res = await fetch(streamUrl, {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Referer": paginaHide,
        "Origin": new URL(paginaHide).origin,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 404 || res.status === 410) {
      return { removido: true, motivo: "removido", status: res.status };
    }
    if (!res.ok) {
      return { removido: false, motivo: "inconclusivo", status: res.status };
    }

    const corpo = await res.text();
    const cabe = corpo.length <= HIDE_MANIFEST_INLINE_MAX && corpo.startsWith("#EXTM3U");
    return { removido: false, motivo: "ok", status: res.status, ...(cabe ? { manifest: corpo } : {}) };
  } catch {
    // Timeout ou falha de rede não provam que o arquivo sumiu.
    return { removido: false, motivo: "inconclusivo" };
  }
}
