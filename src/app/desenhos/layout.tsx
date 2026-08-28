import { catalogPageMetadata } from "@/lib/seo";

export const metadata = catalogPageMetadata(
  "Desenhos",
  "Explore desenhos e animações no catálogo Obaflix por ano, gênero, popularidade e avaliação.",
  "/desenhos",
);

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
