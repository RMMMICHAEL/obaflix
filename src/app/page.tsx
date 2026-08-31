import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/LandingPage";
import { HomeStreaming } from "@/components/home/HomeStreaming";
import { WEB_STREAMING_ENABLED } from "@/config/site-mode";

export const revalidate = 300;

/**
 * A raiz do site.
 *
 * Só o navegador comum chega aqui: Android e Electron são reescritos pelo
 * middleware para `/android` e `/desktop` antes desta rota renderizar (ver
 * `src/config/site-mode.ts`). Então este arquivo não precisa saber nada sobre
 * ambiente — só se o streaming web está aberto ou fechado.
 */
export function generateMetadata(): Metadata {
  if (WEB_STREAMING_ENABLED) return {};
  const titulo = "Obaflix | Baixe o app para Android, Android TV, TV Box e Windows";
  const descricao =
    "Baixe o aplicativo Obaflix e assista a filmes, séries e animes no Android, Android TV, TV Box e Windows. Pareie a sua TV em poucos segundos.";
  return {
    title: titulo,
    description: descricao,
    alternates: { canonical: "/" },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      locale: "pt_BR",
      url: "/",
      siteName: "Obaflix",
      title: titulo,
      description: descricao,
      images: [{ url: "/placeholder-bg.jpg", width: 1280, height: 720, alt: "Obaflix" }],
    },
    twitter: {
      card: "summary_large_image",
      title: titulo,
      description: descricao,
      images: ["/placeholder-bg.jpg"],
    },
  };
}

export default async function HomePage() {
  if (!WEB_STREAMING_ENABLED) return <LandingPage />;
  return <HomeStreaming />;
}
