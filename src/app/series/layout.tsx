import { catalogPageMetadata } from "@/lib/seo";
// Preserve the runtime behavior previously inherited from the root layout.
export const dynamic = "force-dynamic";

export const metadata = catalogPageMetadata(
  "Séries — temporadas, episódios e onde assistir",
  "Explore séries no catálogo Obaflix: temporadas, episódios, gêneros e informações. Para assistir, baixe o aplicativo para Android, Android TV e Windows.",
  "/series",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
