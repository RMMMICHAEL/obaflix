import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // Camada semântica da tela de Canais ao Vivo (web/Electron). O Android TV
        // espelha os mesmos valores em `Tema.kt`; mudar aqui é mudar lá também.
        live: {
          bg: "#050609",
          surface: "#0D0F14",
          raised: "#12141A",
          line: "#272A32",
          muted: "#8B909C",
          accent: "#E50914",
          glow: "#F20D24",
        },
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        fadeIn: "fadeIn 0.6s ease-in-out forwards",
      },
    },
  },
  plugins: [],
};
export default config;
