import type { Metadata } from "next";

// Página de sessão: nunca indexável. Uma URL /parear?c=CODIGO no índice de busca
// não vaza credencial (o código expira em 10 min e exige login para valer), mas
// gastaria orçamento de crawl num espaço de URLs sem fim.
export const metadata: Metadata = {
  title: "Conectar TV",
  robots: { index: false, follow: false },
};

export default function LayoutParear({ children }: { children: React.ReactNode }) {
  return children;
}
