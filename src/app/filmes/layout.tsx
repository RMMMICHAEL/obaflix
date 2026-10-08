import { catalogPageMetadata } from "@/lib/seo";
// Preserve the runtime behavior previously inherited from the root layout.
export const dynamic = "force-dynamic";

export const metadata = catalogPageMetadata(
  "Filmes — lançamentos, populares e onde assistir",
  "Descubra filmes no catálogo Obaflix: lançamentos, populares, gêneros e informações. Para assistir, baixe o aplicativo para Android, Android TV e Windows.",
  "/filmes",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
