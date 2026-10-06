import type { Metadata } from "next";
import { Ellipsis } from "lucide-react";
import { SecaoDownloads } from "@/components/landing/SecaoDownloads";
import { INSTALADORES } from "@/config/downloads";

export const metadata: Metadata = {
  title: "Download pelo TikTok",
  description: "Abra no navegador do celular e baixe o Obaflix para Android, Android TV ou Windows.",
  robots: { index: false, follow: true },
  alternates: { canonical: "/" },
};

export default function TikTokPage() {
  return (
    <div data-obaflix-landing className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 sm:pt-8 lg:px-10">
        <span className="text-xl font-black tracking-[-0.055em] text-red-500">
          OBA<span className="text-zinc-100">FLIX</span>
        </span>
      </header>

      <section aria-labelledby="abrir-navegador" className="mx-auto max-w-6xl px-4 pb-8 pt-8 sm:px-6 sm:pt-12 lg:px-10">
        <div className="max-w-2xl">
          <h1 id="abrir-navegador" className="text-3xl font-black leading-tight tracking-tight sm:text-5xl">
            Para baixar o Obaflix, abra esta página no navegador do celular.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-zinc-400 sm:text-base">
            O navegador dentro do TikTok pode impedir o download. Siga estes passos:
          </p>

          <ol className="mt-6 space-y-5 text-base leading-relaxed">
            <li className="flex items-start gap-3">
              <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-600 text-sm font-bold">1</span>
              <p>
                Toque nos três pontinhos <span className="inline-flex align-middle rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1"><Ellipsis size={20} aria-hidden="true" /><span className="sr-only">⋯</span></span> no <strong>canto superior direito</strong>.
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-600 text-sm font-bold">2</span>
              <p>Toque em <strong className="text-red-400">“Abrir no navegador”</strong>.</p>
            </li>
            <li className="flex items-start gap-3">
              <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-600 text-sm font-bold">3</span>
              <p>Depois escolha <strong>Android, Android TV ou Windows</strong> e faça o download abaixo.</p>
            </li>
          </ol>
        </div>
        <p className="mt-8 border-t border-zinc-800 pt-6 text-lg font-bold">
          Já abriu no Chrome ou Safari? Baixe abaixo.
        </p>
      </section>

      <SecaoDownloads
        android={INSTALADORES.android}
        androidTv={INSTALADORES.androidTv}
        windows={INSTALADORES.windows}
      />
    </div>
  );
}
