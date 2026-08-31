"use client";

import Link from "next/link";
import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { RankCard } from "./RankCard";

interface Item {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  /** Disponibilidade de audio, nunca a URL da fonte. */
  dub?: boolean;
  leg?: boolean;
  isNew?: boolean;
}

interface Props {
  titulo: string;
  items: Item[];
  verTodosHref?: string;
}

export function RankRow({ titulo, items, verTodosHref }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Avanca quase uma "tela" da fileira em vez de um valor fixo: com os cards
  // grandes, 600px deixava meio poster cortado em telas largas.
  const scroll = (dir: "left" | "right") => {
    const el = ref.current;
    if (!el) return;
    const passo = Math.max(240, el.clientWidth * 0.85);
    const limite = el.scrollWidth - el.clientWidth;
    const destino = Math.min(limite, Math.max(0, el.scrollLeft + (dir === "left" ? -passo : passo)));
    el.scrollTo({ left: destino, behavior: "smooth" });
  };

  if (!items.length) return null;

  return (
    <section className="mb-1 md:mb-3">
      <div className="flex items-center gap-3 mb-2 px-4 md:px-14">
        <h2 className="text-white font-semibold text-base md:text-lg tracking-tight">{titulo}</h2>
        {verTodosHref && (
          <Link href={verTodosHref} className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors flex-none">
            Ver todos →
          </Link>
        )}
      </div>

      <div className="relative group/row">
        <button
          onClick={() => scroll("left")}
          className="absolute left-0 top-0 bottom-0 z-10 w-12 md:w-14 bg-gradient-to-r from-zinc-950 to-transparent text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronLeft size={22} />
        </button>

        <div
          ref={ref}
          // Sem listener de wheel: no desktop o elemento nao e rolavel pelo
          // usuario no eixo X, e o deltaY segue naturalmente para a pagina.
          // `overflow-y-hidden` e explicito porque, pelas regras de overflow do
          // CSS, combinar X hidden/auto com Y visible faria Y computar como auto
          // e criaria uma area vertical interna. As setas ainda usam scrollTo;
          // no mobile, X auto preserva o swipe horizontal nativo.
          // O respiro vertical existe porque overflow-x tambem recorta no eixo Y:
          // sem ele, o hover (elevacao + escala + sombra) seria cortado.
          className="flex items-end gap-3 md:gap-6 overflow-x-auto overflow-y-hidden md:overflow-x-hidden scrollbar-hide px-4 md:px-14 pt-8 pb-10"
        >
          {items.slice(0, 10).map((item, i) => (
            <RankCard key={item.id} rank={i + 1} isNew={item.isNew} {...item} />
          ))}
        </div>

        <button
          onClick={() => scroll("right")}
          className="absolute right-0 top-0 bottom-0 z-10 w-12 md:w-14 bg-gradient-to-l from-zinc-950 to-transparent text-white opacity-0 group-hover/row:opacity-100 transition flex items-center justify-center"
        >
          <ChevronRight size={24} />
        </button>
      </div>
    </section>
  );
}
