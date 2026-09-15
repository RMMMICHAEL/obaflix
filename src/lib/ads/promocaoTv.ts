/**
 * A promoção interna da Android TV — o vídeo próprio do Obaflix exibido antes da
 * reprodução gratuita.
 *
 * ## Por que configuração de servidor, e não constante no APK
 *
 * Trocar o vídeo, a versão ou a duração não pode exigir publicar um APK novo. E a
 * duração não é só apresentação: é ela que `/api/ads/complete` usa como tempo
 * mínimo entre o início e a conclusão da sessão promocional. Se viesse do
 * cliente, o cliente escolheria quanto tempo precisa esperar.
 *
 * Três variáveis, todas **servidor apenas** (nunca `NEXT_PUBLIC_`):
 *
 * ```text
 * PROMOCAO_TV_VIDEO_URL     https obrigatório, sem credencial na URL
 * PROMOCAO_TV_DURACAO_SEG   inteiro entre DURACAO_MINIMA_S e DURACAO_MAXIMA_S
 * PROMOCAO_TV_VERSAO        opcional, [A-Za-z0-9._-]{1,32}; padrão "1"
 * ```
 *
 * A URL não é segredo — o vídeo é nosso e público, no R2 —, mas vale a mesma
 * higiene do Direct Link: nenhuma URL definitiva mora no repositório, e o log
 * recebe só o host.
 *
 * ## Falha fecha
 *
 * Qualquer valor ausente ou inválido devolve `indisponivel`. Quem chama responde
 * `ANUNCIO_INDISPONIVEL` e **não** abre desafio: sem vídeo não há promoção a
 * cumprir, e liberar conteúdo porque a configuração faltou seria o fail-open que
 * `meioDeExibicao` existe para fechar.
 */

/** O que o desafio grava da promoção no instante em que é aberto. */
export interface PromocaoTv {
  /** Identifica a peça. Vai para o log, e permite trocar o vídeo sem ambiguidade. */
  versao: string;
  /** Endereço do vídeo, entregue à TV só quando a sessão promocional começa. */
  videoUrl: string;
  /** Duração confiável, em ms. É o tempo mínimo entre início e conclusão. */
  duracaoMs: number;
}

/**
 * Limites da duração declarada.
 *
 * O piso impede uma configuração que torne a conclusão praticamente instantânea
 * — e portanto automatizável — e fica acima do `TEMPO_MINIMO_DE_ANUNCIO_MS`
 * global, que `/api/ads/complete` também aplica: uma promoção mais curta que ele
 * seria recusada mesmo assistida até o fim. O teto mantém o "vídeo rápido"
 * prometido na tela e limita por quanto tempo um desafio fica vivo no Redis.
 */
export const DURACAO_MINIMA_S = 10;
export const DURACAO_MAXIMA_S = 180;

export const VERSAO_PADRAO = "1";

export type ResolucaoDaPromocaoTv =
  | { situacao: "ok"; promocao: PromocaoTv }
  | { situacao: "indisponivel"; motivo: "ausente" | "url_invalida" | "duracao_invalida" | "versao_invalida" };

export function resolverPromocaoTv(
  env: Record<string, string | undefined> = process.env,
): ResolucaoDaPromocaoTv {
  const brutaUrl = env.PROMOCAO_TV_VIDEO_URL?.trim();
  const brutaDuracao = env.PROMOCAO_TV_DURACAO_SEG?.trim();
  if (!brutaUrl || !brutaDuracao) return { situacao: "indisponivel", motivo: "ausente" };

  let url: URL;
  try {
    url = new URL(brutaUrl);
  } catch {
    return { situacao: "indisponivel", motivo: "url_invalida" };
  }
  // `https:` fecha `http:`, `file:`, `data:` e `javascript:` de uma vez. Usuário
  // e senha na URL seriam credencial entregue ao aparelho — recusado.
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return { situacao: "indisponivel", motivo: "url_invalida" };
  }

  // Estrito: "30s", "30.5", " 30 " depois do trim já passou, "1e2" não.
  if (!/^\d{1,4}$/.test(brutaDuracao)) return { situacao: "indisponivel", motivo: "duracao_invalida" };
  const segundos = Number(brutaDuracao);
  if (segundos < DURACAO_MINIMA_S || segundos > DURACAO_MAXIMA_S) {
    return { situacao: "indisponivel", motivo: "duracao_invalida" };
  }

  const brutaVersao = env.PROMOCAO_TV_VERSAO?.trim();
  const versao = brutaVersao ? brutaVersao : VERSAO_PADRAO;
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(versao)) return { situacao: "indisponivel", motivo: "versao_invalida" };

  return {
    situacao: "ok",
    promocao: { versao, videoUrl: url.toString(), duracaoMs: segundos * 1000 },
  };
}
