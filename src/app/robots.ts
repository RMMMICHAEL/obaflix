import type { MetadataRoute } from "next";
import { absoluteUrl, catalogIndexingEnabled } from "@/lib/seo";

/**
 * Enquanto CONTENT_INDEXING_ENABLED estiver desligado, as fichas ja respondem
 * `noindex` e o sitemap nao anuncia nenhuma delas — mas nada impedia o crawler
 * de chegar nelas pelos links das listagens. Cada visita dessas custa um render
 * e uma escrita de ISR para produzir uma pagina que o buscador vai descartar.
 *
 * O Disallow sai sozinho quando a flag for ligada: e a mesma variavel que
 * controla o `noindex` e o sitemap, entao nao ha como esquecer de reverter e
 * bloquear a indexacao sem querer.
 */
const CATALOGO_FECHADO = ["/filme/", "/serie/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Areas de sessao, reproducao e busca. Reproducao ja exige login (redireciona
      // para /login), mas sem o Disallow o crawler gasta orcamento no redirect e
      // pode indexar a URL de login com callbackUrl. Busca fica de fora porque
      // ?q= gera espaco de URLs sem fim.
      disallow: [
        "/api/",
        "/admin/",
        "/conta/",
        "/login/",
        "/cadastro/",
        "/player/",
        "/assistir/",
        "/buscar/",
        // Pareamento de TV: ?c=CODIGO gera espaco de URLs sem fim, e a pagina
        // exige sessao para fazer qualquer coisa.
        "/parear/",
        ...(catalogIndexingEnabled ? [] : CATALOGO_FECHADO),
      ],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
