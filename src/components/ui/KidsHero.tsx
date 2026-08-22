import Image from "next/image";
import Link from "next/link";
import { Play, Sparkles } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

export interface KidsHeroItem {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  background?: string | null;
}

export function KidsHero({ items }: { items: KidsHeroItem[] }) {
  return (
    <section className="relative isolate min-h-[310px] overflow-hidden bg-[oklch(0.74_0.13_195)] px-6 pb-9 pt-24 md:min-h-[360px] md:px-12 md:pb-11 md:pt-28">
      <div className="absolute -left-16 bottom-[-5rem] h-52 w-52 rounded-full bg-[oklch(0.86_0.16_96/0.72)]" aria-hidden="true" />
      <div className="absolute right-[6%] top-[-5rem] h-64 w-64 rounded-full bg-[oklch(0.71_0.17_160/0.55)]" aria-hidden="true" />
      <div className="absolute bottom-[-7rem] left-[42%] h-64 w-64 rounded-full bg-[oklch(0.78_0.15_235/0.45)]" aria-hidden="true" />

      <div className="relative z-10 mx-auto grid max-w-7xl items-center gap-8 md:grid-cols-[minmax(0,1fr)_420px]">
        <div>
          <p className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[oklch(0.27_0.075_205)]">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Mundo da animação
          </p>
          <h1 className="max-w-[14ch] text-4xl font-black leading-[0.98] tracking-[-0.045em] text-[oklch(0.20_0.055_205)] md:text-5xl">
            Um mundo inteiro para brincar
          </h1>
          <p className="mt-4 max-w-[58ch] text-sm font-medium leading-6 text-[oklch(0.29_0.055_205)] md:text-base">
            Novidades, clássicos e coleções organizados para encontrar uma história rapidinho.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href="#estudios"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[oklch(0.24_0.075_205)] px-5 text-sm font-bold text-[oklch(0.96_0.015_195)] transition-colors duration-200 hover:bg-[oklch(0.29_0.08_205)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.20_0.055_205)]"
            >
              <Sparkles className="h-4 w-4" /> Explorar estúdios
            </a>
            {items[0] && (
              <Link
                href={items[0].tipo === "filme" ? `/filme/${items[0].id}` : `/serie/${items[0].id}`}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[oklch(0.88_0.16_96)] px-5 text-sm font-bold text-[oklch(0.24_0.065_205)] transition-colors hover:bg-[oklch(0.92_0.13_96)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.20_0.055_205)]"
              >
                <Play className="h-4 w-4" fill="currentColor" /> Assistir destaque
              </Link>
            )}
          </div>
        </div>

        <div className="hidden grid-cols-3 items-center gap-4 md:grid" aria-label="Destaques de animação">
          {items.slice(0, 3).map((item, index) => (
            <Link
              key={`${item.tipo}-${item.id}`}
              href={item.tipo === "filme" ? `/filme/${item.id}` : `/serie/${item.id}`}
              className={`block aspect-video overflow-hidden rounded-2xl bg-[oklch(0.25_0.05_205)] shadow-xl ring-2 ring-[oklch(0.94_0.025_195/0.55)] transition-transform duration-200 ease-out hover:-translate-y-1 focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-[oklch(0.20_0.055_205)] ${index === 1 ? "-translate-y-4" : "translate-y-3"}`}
              aria-label={item.titulo}
            >
              <Image
                src={item.background ? imgUrl(item.background, "w780") : item.poster ? imgUrl(item.poster, "w342") : "/placeholder.jpg"}
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
