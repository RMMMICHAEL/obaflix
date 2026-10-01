import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { BannerDesktop } from "./BannerDesktop";

/**
 * Intercala um banner `feed` depois de cada fileira principal:
 *
 *   Em Alta → banner → Filmes Populares → banner → Top 10 → banner …
 *
 * Serve em Server Component (só percorre os filhos). Filhos condicionais que
 * resultam em `false`/`null` somem antes da intercalação, então fileira ausente
 * não gera dois banners seguidos. Fora do app Windows, `BannerDesktop` não
 * renderiza nada — as fileiras ficam exatamente como antes.
 *
 * Deixe fora daqui o que pode renderizar vazio no cliente (ex.:
 * `ContinuarAssistindo`), senão sobra banner colado em banner.
 */
export function ComBanners({ children }: { children: ReactNode }) {
  const fileiras = Children.toArray(children).filter(isValidElement);
  return (
    <>
      {fileiras.map((fileira, i) => (
        <Fragment key={fileira.key ?? i}>
          {fileira}
          <BannerDesktop posicao="feed" />
        </Fragment>
      ))}
    </>
  );
}
