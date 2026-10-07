/**
 * Fase Velocidade 1B — backdrop responsivo do hero.
 *
 * `images.unoptimized: true` no next.config desliga o optimizer da Vercel:
 * o next/image passa a servir o `src` cru, SEM gerar srcset. Com isso, um
 * `imgUrl(backdrop, "original")` manda o backdrop em tamanho cheio (~3840px,
 * vários MB) para todo viewport, inclusive celular — e ainda o preloada.
 *
 * O loader abaixo devolve o srcset ao hero sem reativar o optimizer: mapeia a
 * largura que o browser pede (já com o DPR aplicado) para o token nativo do
 * TMDB. O TMDB vira o "optimizer" — e ele já está no CSP/remotePatterns. Assim
 * mobile recebe w780, desktop w1280 e tela grande/4K/Retina recebe `original`,
 * preservando a qualidade onde ela aparece.
 */

import type { ImageLoaderProps } from "next/image";
import { IMG } from "./tmdb";

/** Degraus de backdrop do TMDB: largura máxima coberta → token nativo. */
const BACKDROP_STEPS: { max: number; token: string }[] = [
  { max: 300, token: "w300" },
  { max: 780, token: "w780" },
  { max: 1280, token: "w1280" },
];

/**
 * Menor token de backdrop que cobre `width`. Acima de 1280 (monitores grandes,
 * 4K, Retina de notebook) cai em `original` para não degradar a arte.
 */
export function backdropToken(width: number): string {
  for (const step of BACKDROP_STEPS) {
    if (width <= step.max) return step.token;
  }
  return "original";
}

/**
 * Loader de backdrop para o next/image do hero. URL completa passa direto (já
 * é final); caminho do TMDB (`/abc.jpg`) ganha o token adequado à largura.
 */
export function tmdbBackdropLoader({ src, width }: ImageLoaderProps): string {
  if (/^https?:\/\//.test(src)) return src;
  const path = src.startsWith("/") ? src : `/${src}`;
  return `${IMG}/${backdropToken(width)}${path}`;
}
