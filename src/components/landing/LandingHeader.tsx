import Link from "next/link";
import { Download, Tv } from "lucide-react";

/**
 * Cabeçalho da landing. Só dois destinos, de propósito: baixar o app e parear a
 * TV. Não há link para nenhuma página do catálogo enquanto o streaming web
 * estiver fechado.
 */
export function LandingHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-zinc-950/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6 lg:px-10">
        <span className="select-none text-xl font-black tracking-[-0.055em] text-red-600 sm:text-2xl">
          OBA<span className="text-white">FLIX</span>
        </span>

        <nav className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/parear"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-2 text-xs font-semibold text-white transition hover:border-white/35 hover:bg-white/5 sm:px-4 sm:text-sm"
          >
            <Tv size={16} />
            Parear TV
          </Link>
          <a
            href="#baixar"
            className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3.5 py-2 text-xs font-bold text-white shadow-lg shadow-red-900/40 transition hover:bg-red-500 active:scale-95 sm:px-5 sm:text-sm"
          >
            <Download size={16} />
            Baixar agora
          </a>
        </nav>
      </div>
    </header>
  );
}
