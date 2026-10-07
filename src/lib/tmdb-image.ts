/**
 * Fase Velocidade 1B — backdrop responsivo do hero.
 *
 * `images.unoptimized: true` no next.config desliga o optimizer da Vercel. E
 * essa flag é GLOBAL e vence qualquer `unoptimized={false}` por imagem: em
 * get-img-props o Next faz `if (config.unoptimized) unoptimized = true` depois
 * de ler o prop, e quando `unoptimized` é true o next/image devolve o `src` cru
 * SEM chamar o loader e SEM srcset. Ou seja: loader custom + unoptimized={false}
 * no <Image> não produz srcset nenhum aqui — mediríamos isso tarde.
 *
 * Então o hero monta o srcset à mão, num <img> normal (o mesmo padrão que o
 * logo do hero já usa), fora do alcance da flag global. Cada candidato aponta
 * para um token nativo do TMDB (que já está no CSP/remotePatterns), com o
 * descritor de largura real. Com `sizes="100vw"` o browser escolhe por
 * viewport × DPR: telefone recebe w780/w1280 e NUNCA original; notebook grande,
 * 4K e Retina recebem original, preservando a arte.
 */

import { IMG } from "./tmdb";

/** Candidatos de backdrop: token nativo do TMDB + largura real em px. */
const HERO_BACKDROP_CANDIDATES: { token: string; width: number }[] = [
  { token: "w780", width: 780 },
  { token: "w1280", width: 1280 },
  // `original` não tem largura fixa; o descritor alto garante que só telas que
  // realmente precisam de >1280px (grandes/4K/Retina) o escolham.
  { token: "original", width: 3840 },
];

const isFullUrl = (path: string) => /^https?:\/\//.test(path);
const withSlash = (path: string) => (path.startsWith("/") ? path : `/${path}`);

/**
 * `srcSet` do backdrop do hero. URL completa não tem variantes de token, então
 * devolve `undefined` (o `src` já basta). Caminho do TMDB vira a lista de
 * candidatos com descritores `w`.
 */
export function heroBackdropSrcSet(path: string): string | undefined {
  if (isFullUrl(path)) return undefined;
  const p = withSlash(path);
  return HERO_BACKDROP_CANDIDATES.map(({ token, width }) => `${IMG}/${token}${p} ${width}w`).join(", ");
}

/**
 * `src` de fallback do backdrop (navegadores que ignoram `srcSet`). w1280 é um
 * meio-termo seguro — nem o `original` pesado, nem o w780 pequeno em desktop.
 */
export function heroBackdropSrc(path: string): string {
  if (isFullUrl(path)) return path;
  return `${IMG}/w1280${withSlash(path)}`;
}
