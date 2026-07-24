import type { Metadata } from "next";
import { Inter, Bebas_Neue } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Navbar } from "@/components/layout/Navbar";
import { DesktopUpdateBanner } from "@/components/ui/DesktopUpdateBanner";
import { PlayerWakeLock } from "@/components/player/PlayerWakeLock";

const inter = Inter({ subsets: ["latin"] });

const bebas = Bebas_Neue({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bebas",
});

export const metadata: Metadata = {
  title: "Streamix — Filmes e Séries Online",
  description:
    "Assista filmes, séries, animes e desenhos online grátis.",
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
      </head>

      <body
        className={`${inter.className} ${bebas.variable} bg-zinc-950 text-white min-h-screen`}
      >
        <Providers>
          <PlayerWakeLock />
          <Navbar />
          <main>{children}</main>
          <DesktopUpdateBanner />
        </Providers>
      </body>
    </html>
  );
}
