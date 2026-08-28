import { catalogPageMetadata } from "@/lib/seo";

export const metadata = catalogPageMetadata(
  "Filmes",
  "Descubra filmes no catálogo Obaflix, com sinopses, ano, duração, gêneros e informações atualizadas.",
  "/filmes",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
