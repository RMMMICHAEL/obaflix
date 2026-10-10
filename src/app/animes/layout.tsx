import { catalogPageMetadata } from "@/lib/seo";
// Preserve the runtime behavior previously inherited from the root layout.
export const dynamic = "force-dynamic";

export const metadata = catalogPageMetadata(
  "Animes",
  "Encontre animes no catálogo Obaflix, com temporadas, episódios recentes, sinopses e informações organizadas.",
  "/animes",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
