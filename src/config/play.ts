/**
 * A distribuição Google Play, identificada em um lugar só.
 *
 * O app da Play é a MESMA casca WebView do APK direto, com uma diferença de
 * build (Estágio 1): o User-Agent ganha `ObaflixPlay/` e o shim nativo expõe
 * `window.__OBAFLIX_PLAY_STORE__ = true` e a capability `downloads: false`.
 *
 * A política da Play exige que esse app seja **somente consumo**: nada de
 * compra, PIX, checkout ou download offline. Este arquivo concentra como
 * reconhecer esse cliente e os códigos/mensagens estáveis que o resto do
 * projeto usa para recusá-lo — assim não existe uma segunda regra escondida.
 *
 * ## O que `ObaflixPlay/` significa no servidor — e o que NÃO significa
 *
 * No servidor o User-Agent só serve para **restringir** o cliente Play: quem o
 * envia perde acesso a compra; quem não o envia continua exatamente como antes.
 * Ele nunca **autoriza** nada. Falsificá-lo não dá acesso a lugar nenhum — no
 * máximo a própria pessoa se restringe. Por isso é seguro depender dele aqui:
 * é a mesma natureza de roteamento do `site-mode.ts`, não credencial.
 */

/** O marcador que o build Play acrescenta ao User-Agent (ver MainActivity.kt). */
export const UA_PLAY = /ObaflixPlay\//i;

/**
 * `true` quando a requisição vem do app da Google Play.
 *
 * Função pura, para o servidor (middleware e rotas): recebe o User-Agent e
 * decide. Só RESTRINGE — ver a nota no topo do arquivo.
 */
export function ehClientePlay(userAgent: string | null | undefined): boolean {
  return UA_PLAY.test(userAgent ?? "");
}

/**
 * Versão cliente: lê a flag do shim nativo e, como reforço, o User-Agent.
 *
 * Usada só para **esconder** CTAs comerciais/de download na interface. Nunca
 * autoriza nada — a recusa de verdade é no servidor (`ehClientePlay`) e no
 * bridge nativo (Estágio 1).
 */
export function ehClientePlayNoNavegador(): boolean {
  if (typeof window === "undefined") return false;
  const flag = (window as { __OBAFLIX_PLAY_STORE__?: unknown }).__OBAFLIX_PLAY_STORE__ === true;
  if (flag) return true;
  const ponte = (window as { obaflixDesktop?: { isPlayStore?: unknown } }).obaflixDesktop;
  if (ponte?.isPlayStore === true) return true;
  return typeof navigator !== "undefined" && UA_PLAY.test(navigator.userAgent);
}

/**
 * Rotas comerciais que o cliente Play não pode abrir: catálogo de planos e o
 * checkout. Limite de prefixo, como o `dentroDe` do `site-mode.ts`: bloqueia
 * `/planos`, `/planos/x`, `/planos?x`, `/checkout` e `/checkout?x`, mas nunca
 * `/planos-falso` nem `/conta`.
 */
export function rotaComercialBloqueadaNoPlay(pathname: string): boolean {
  return /^\/(?:planos|checkout)(?:[/?#]|$)/.test(pathname);
}

/**
 * O que a seção de assinatura da `/conta` mostra, decidido fail-closed.
 *
 * `play` chega `null` enquanto a detecção não rodou (primeiro render, antes da
 * hidratação/efeito). Nesse estado desconhecido NÃO se mostra CTA comercial: um
 * cliente Play não pode ver "Ver planos" nem por um instante. Só quando a
 * detecção confirma `false` é que o CTA aparece.
 *
 *   - `neutro`      → mensagem neutra (Play);
 *   - `cta`         → "Ver planos" (não-Play confirmado);
 *   - `indefinido`  → nada ainda (desconhecido; fail-closed, sem compra).
 */
export type CtaAssinaturaConta = "neutro" | "cta" | "indefinido";

export function ctaAssinaturaConta(play: boolean | null): CtaAssinaturaConta {
  if (play === null) return "indefinido";
  return play ? "neutro" : "cta";
}

/**
 * Para onde a ação "assinar / remover anúncios" do convite de anúncio navega.
 *
 * Fail-closed por natureza: no Play devolve `null` — a ação cancela o anúncio
 * como sempre, mas nunca navega para rota comercial nem abre site/navegador.
 * Fora do Play devolve o destino de sempre (calculado por quem chama). É defesa
 * extra: mesmo que um CTA comercial reapareça por engano no futuro, no Play ele
 * não leva a lugar nenhum.
 */
export function rotaAoAssinar(play: boolean, navegarPara: string | null | undefined): string | null {
  if (play) return null;
  return navegarPara ?? null;
}

/** Código estável da recusa de compra no cliente Play. Nunca muda — o cliente ramifica por ele. */
export const CODIGO_COMPRAS_INDISPONIVEIS_PLAY = "compras_indisponiveis_play";

/** A única mensagem neutra que o app Play mostra no lugar dos CTAs de assinatura. */
export const MENSAGEM_ASSINATURA_INDISPONIVEL_PLAY =
  "Compras e alterações de assinatura não estão disponíveis neste aplicativo.";
