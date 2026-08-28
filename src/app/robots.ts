import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";

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
      ],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
