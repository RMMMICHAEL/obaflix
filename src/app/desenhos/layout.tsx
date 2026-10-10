import { catalogPageMetadata } from "@/lib/seo";
// Preserve the runtime behavior previously inherited from the root layout.
export const dynamic = "force-dynamic";

export const metadata = catalogPageMetadata(
  "Desenhos",
  "Explore desenhos e animações no catálogo Obaflix por ano, gênero, popularidade e avaliação.",
  "/desenhos",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
