import Link from "next/link";
import { Download, PlayCircle, Tv } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

/**
 * Hero. O mosaico de fundo reaproveita backdrops que a página já carregou para
 * as vitrines — nenhuma requisição extra, nenhuma query a mais.
 *
 * A moldura à direita é o aparelho, desenhada em CSS, e o print do app entra
 * dentro dela por `/app-mockup.webp` — na proporção real da tela que gerou a
 * captura (1080×2220), para nada esticar nem cortar. Vem por `background-image`
 * de propósito: se o arquivo sumir, a falha é silenciosa e a moldura continua
 * de pé com a marca no lugar, em vez de um ícone quebrado.
 */
export function LandingHero({ fundos }: { fundos: (string | null)[] }) {
  const mosaico = fundos.filter(Boolean).slice(0, 6) as string[];

  return (
    <section className="relative overflow-hidden pt-14 sm:pt-16">
      {/* Mosaico de fundo */}
      <div aria-hidden className="absolute inset-0">
        <div className="grid h-full w-full grid-cols-2 opacity-[0.4] sm:grid-cols-3">
          {mosaico.map((path, i) => (
            <img
              key={i}
              src={imgUrl(path, "w780")}
              alt=""
              loading={i < 3 ? "eager" : "lazy"}
              decoding="async"
              className="h-full w-full object-cover"
            />
          ))}
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-zinc-950/55 via-zinc-950/85 to-zinc-950" />
        <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_15%_0%,rgba(229,9,20,0.34),transparent_62%)]" />
      </div>

      <div className="relative mx-auto grid max-w-7xl items-center gap-10 px-4 pb-10 pt-12 sm:px-6 sm:pb-16 sm:pt-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14 lg:px-10 lg:pb-24 lg:pt-28">
        <div className="obaflix-reveal text-center lg:text-left">
          <span className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-red-400">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            Agora no aplicativo
          </span>

          <h1 className="mt-5 text-4xl font-black leading-[1.03] tracking-tight text-white sm:text-6xl lg:text-7xl">
            Filmes, séries e animes
            <span className="block bg-gradient-to-r from-red-500 via-red-400 to-orange-300 bg-clip-text text-transparent">
              na sua TV e no seu bolso
            </span>
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-white/60 sm:text-lg lg:mx-0">
            O Obaflix agora é aplicativo. Assista no{" "}
            <strong className="font-semibold text-white/90">Android</strong>, na{" "}
            <strong className="font-semibold text-white/90">Android TV</strong>, na{" "}
            <strong className="font-semibold text-white/90">TV Box</strong> e no{" "}
            <strong className="font-semibold text-white/90">Windows</strong> — com uma conta só,
            continuando de onde parou em qualquer aparelho.
          </p>

          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row lg:justify-start">
            <a
              href="#baixar"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-7 py-3.5 text-base font-bold text-white shadow-xl shadow-red-950/50 transition hover:bg-red-500 active:scale-[0.98]"
            >
              <Download size={19} />
              Baixar agora
            </a>
            <Link
              href="/parear"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/5 px-7 py-3.5 text-base font-bold text-white backdrop-blur transition hover:border-white/40 hover:bg-white/10 active:scale-[0.98]"
            >
              <Tv size={19} />
              Parear TV
            </Link>
          </div>

          <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-white/40 lg:justify-start">
            <li className="flex items-center gap-1.5">
              <PlayCircle size={14} className="text-red-500" /> Catálogo completo
            </li>
            <li className="flex items-center gap-1.5">
              <PlayCircle size={14} className="text-red-500" /> Dublado e legendado
            </li>
            <li className="flex items-center gap-1.5">
              <PlayCircle size={14} className="text-red-500" /> Continue assistindo
            </li>
          </ul>
        </div>

        {/* O aparelho: moldura em CSS, print do app dentro */}
        <div className="obaflix-reveal relative isolate mx-auto w-full max-w-[292px]">
          <div aria-hidden className="absolute -inset-8 rounded-full bg-red-600/25 blur-3xl" />
          <div className="obaflix-flutua relative rounded-[1.75rem] border border-white/12 bg-gradient-to-b from-white/10 to-white/[0.02] p-2 shadow-2xl shadow-black/70 backdrop-blur">
            <div className="relative aspect-[1080/2220] overflow-hidden rounded-[1.35rem] bg-zinc-900">
              {/* Camada de baixo: se o print sumir, é isto que aparece. */}
              <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(70%_50%_at_50%_0%,rgba(229,9,20,0.35),transparent_70%)]">
                <span className="text-2xl font-black tracking-[-0.055em] text-red-600/50">
                  OBA<span className="text-white/50">FLIX</span>
                </span>
              </div>
              <div
                role="img"
                aria-label="Tela inicial do aplicativo Obaflix"
                className="absolute inset-0 bg-cover bg-top"
                style={{ backgroundImage: "url(/app-mockup.webp)" }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
