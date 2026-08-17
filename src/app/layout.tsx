import type { Metadata } from "next";
import { Inter, Bebas_Neue } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Navbar } from "@/components/layout/Navbar";
import { AndroidShell } from "@/components/layout/AndroidShell";
import { APP_MODE_BOOTSTRAP_SCRIPT, AppModeProvider } from "@/components/layout/AppMode";
import { DesktopUpdateBanner } from "@/components/ui/DesktopUpdateBanner";
import { PlayerWakeLock } from "@/components/player/PlayerWakeLock";
import { JsonLd } from "@/components/seo/JsonLd";
import { absoluteUrl, DEFAULT_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/seo";

const inter = Inter({ subsets: ["latin"] });

const bebas = Bebas_Neue({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bebas",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: {
    default: "Obaflix | Filmes, séries, animes e desenhos",
    template: "%s | Obaflix",
  },
  description: DEFAULT_DESCRIPTION,
  alternates: { canonical: "/" },
  category: "entertainment",
  keywords: ["Obaflix", "filmes", "séries", "animes", "desenhos", "catálogo de entretenimento"],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  formatDetection: { address: false, email: false, telephone: false },
  openGraph: {
    type: "website",
    locale: "pt_BR",
    url: "/",
    siteName: SITE_NAME,
    title: "Obaflix | Filmes, séries, animes e desenhos",
    description: DEFAULT_DESCRIPTION,
    images: [{ url: "/placeholder-bg.jpg", width: 1280, height: 720, alt: "Catálogo Obaflix" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Obaflix | Filmes, séries, animes e desenhos",
    description: DEFAULT_DESCRIPTION,
    images: ["/placeholder-bg.jpg"],
  },
  verification: process.env.GOOGLE_SITE_VERIFICATION
    ? { google: process.env.GOOGLE_SITE_VERIFICATION }
    : undefined,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <head>
        <link
          rel="preconnect"
          href="https://image.tmdb.org"
        />
        <link
          rel="dns-prefetch"
          href="https://image.tmdb.org"
        />
        {/* Marca o modo app antes da primeira pintura: sem isso o HTML do SSR
            mostra a navbar desktop por um instante junto da topbar mobile. */}
        <script dangerouslySetInnerHTML={{ __html: APP_MODE_BOOTSTRAP_SCRIPT }} />
      </head>

      <body
        className={`${inter.className} ${bebas.variable} bg-zinc-950 text-white min-h-screen`}
      >
        <JsonLd
          data={[
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              name: SITE_NAME,
              url: SITE_URL,
              logo: absoluteUrl("/favicon.ico"),
            },
            {
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: SITE_NAME,
              alternateName: "Obaflix",
              url: SITE_URL,
              inLanguage: "pt-BR",
            },
          ]}
        />
        <Providers>
          <AppModeProvider>
            <PlayerWakeLock />
            <AndroidShell />
            <Navbar />
            <main>{children}</main>
            <DesktopUpdateBanner />
          </AppModeProvider>
        </Providers>
      </body>
    </html>
  );
}
