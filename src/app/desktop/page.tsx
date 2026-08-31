import type { Metadata } from "next";
import { HomeStreaming } from "@/components/home/HomeStreaming";

// Entrada de aplicativo: renderiza por requisição, sem pré-geração no build.
//
// Pré-gerar aqui não pagava por si: nenhum buscador pede esta rota (o
// middleware só deixa o Electron entrar), e no build ela disputava o pooler do
// Supabase com a landing e estourava `connection_limit=1`. Os dados continuam
// em cache de 300s dentro de `HomeStreaming` — a mesma janela do `revalidate`
// que a home tinha quando era estática, então o Supabase não vê uma query a
// mais por causa desta decisão.
export const dynamic = "force-dynamic";

/**
 * Entrada do Electron.
 *
 * É a mesma home de sempre — literalmente o mesmo componente que `/` serve
 * quando o streaming web está aberto. Existe como rota própria para que o
 * aplicativo tenha um endereço estável que não muda de significado quando a
 * landing ocupa a raiz.
 *
 * O middleware só deixa o Electron entrar aqui; navegador comum é mandado para
 * `/`. Daqui para frente a navegação é a normal do site (`/filmes`, `/serie/…`,
 * `/assistir/…`, `/conta`), toda ela liberada para este ambiente.
 */
export const metadata: Metadata = {
  title: "Obaflix para Windows",
  description: "Catálogo Obaflix no aplicativo para Windows.",
  alternates: { canonical: "/desktop" },
  // Entrada interna de aplicativo: não é página de busca.
  robots: { index: false, follow: false },
};

export default async function DesktopHomePage() {
  return <HomeStreaming />;
}
