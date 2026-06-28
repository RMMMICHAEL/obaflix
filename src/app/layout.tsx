import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Navbar } from "@/components/layout/Navbar";
import { DesktopUpdateBanner } from "@/components/ui/DesktopUpdateBanner";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Streamix — Filmes e Séries Online",
  description: "Assista filmes, séries, animes e desenhos online grátis.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className={`${inter.className} bg-zinc-950 text-white min-h-screen`}>
        <Providers>
          <Navbar />
          <main>{children}</main>
          <DesktopUpdateBanner />
        </Providers>
      </body>
    </html>
  );
}
