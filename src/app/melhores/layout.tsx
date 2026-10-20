import { catalogPageMetadata } from "@/lib/seo";
// Preserve the runtime behavior previously inherited from the root layout.
export const dynamic = "force-dynamic";

export const metadata = catalogPageMetadata(
  "Filmes e séries em destaque",
  "Consulte seleções de filmes e séries em destaque no Obaflix, organizadas por popularidade e avaliação.",
  "/melhores",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
