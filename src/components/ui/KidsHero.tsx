import Image from "next/image";
import Link from "next/link";
import { Play, Sparkles } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

export interface KidsHeroItem {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
}

export function KidsHero({ items }: { items: KidsHeroItem[] }) {
  return (
    <section className="relative isolate min-h-[390px] overflow-hidden bg-[oklch(0.29_0.10_272)] px-6 pb-10 pt-28 md:min-h-[470px] md:px-12 md:pb-14 md:pt-32">
      <div className="absolute -left-20 top-24 h-52 w-52 rounded-full bg-[oklch(0.78_0.17_92/0.28)]" aria-hidden="true" />
      <div className="absolute right-[8%] top-12 h-64 w-64 rounded-full bg-[oklch(0.70_0.18_330/0.22)]" aria-hidden="true" />
      <div className="absolute bottom-[-7rem] left-[35%] h-72 w-72 rounded-full bg-[oklch(0.72_0.15_205/0.22)]" aria-hidden="true" />

      <div className="relative z-10 mx-auto grid max-w-7xl items-center gap-10 md:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
        <div>
          <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-[oklch(0.90_0.11_94)]">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Mundo da animação
          </p>
          <h1 className="max-w-[13ch] text-4xl font-black leading-[1.02] tracking-[-0.045em] text-[oklch(0.97_0.01_275)] md:text-6xl">
            Histórias para todas as idades
          </h1>
          <p className="mt-5 max-w-[58ch] text-sm leading-6 text-[oklch(0.86_0.025_275)] md:text-base">
            Filmes, desenhos e animes organizados por estúdio. Só aparecem títulos que já estão disponíveis no Obaflix.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href="#estudios"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[oklch(0.94_0.02_92)] px-5 text-sm font-bold text-[oklch(0.23_0.07_272)] transition-transform duration-200 ease-out hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Sparkles className="h-4 w-4" /> Explorar estúdios
            </a>
            {items[0] && (
              <Link
                href={items[0].tipo === "filme" ? `/filme/${items[0].id}` : `/serie/${items[0].id}`}
                className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[oklch(0.19_0.045_272)] px-5 text-sm font-bold text-white ring-1 ring-white/15 transition-colors hover:bg-[oklch(0.23_0.055_272)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <Play className="h-4 w-4" fill="currentColor" /> Assistir destaque
              </Link>
            )}
          </div>
        </div>

        <div className="relative hidden h-[315px] md:block" aria-label="Destaques de animação">
          {items.slice(0, 3).map((item, index) => (
            <Link
              key={`${item.tipo}-${item.id}`}
              href={item.tipo === "filme" ? `/filme/${item.id}` : `/serie/${item.id}`}
              className="absolute top-1/2 block aspect-[2/3] w-[168px] overflow-hidden rounded-xl bg-[oklch(0.20_0.04_272)] shadow-2xl ring-1 ring-white/15 transition-transform duration-200 ease-out hover:-translate-y-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
              style={{
                left: `${index * 27}%`,
                zIndex: index === 1 ? 3 : 2 - index,
                transform: `translateY(-50%) rotate(${(index - 1) * 6}deg)`,
              }}
              aria-label={item.titulo}
            >
              <Image
                src={item.poster ? imgUrl(item.poster, "w342") : "/placeholder.jpg"}
                alt={item.titulo}
                fill
                className="object-cover"
                sizes="168px"
              />
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
