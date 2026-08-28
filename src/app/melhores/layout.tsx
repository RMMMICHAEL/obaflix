import { catalogPageMetadata } from "@/lib/seo";

export const metadata = catalogPageMetadata(
  "Filmes e séries em destaque",
  "Consulte seleções de filmes e séries em destaque no Obaflix, organizadas por popularidade e avaliação.",
  "/melhores",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
