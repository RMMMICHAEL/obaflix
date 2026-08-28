import { catalogPageMetadata } from "@/lib/seo";

export const metadata = catalogPageMetadata(
  "Animes",
  "Encontre animes no catálogo Obaflix, com temporadas, episódios recentes, sinopses e informações organizadas.",
  "/animes",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
