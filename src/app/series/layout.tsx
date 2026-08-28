import { catalogPageMetadata } from "@/lib/seo";

export const metadata = catalogPageMetadata(
  "Séries",
  "Explore séries no catálogo Obaflix, com temporadas, episódios, sinopses e informações para escolher o que acompanhar.",
  "/series",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
