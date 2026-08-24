"use client";

import Image from "next/image";
import Link from "next/link";
import { imgUrl } from "@/lib/tmdb";

function imgFallback(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.currentTarget as HTMLImageElement).src = "/placeholder.jpg";
}

interface Props {
  rank: number;
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  isNew?: boolean;
}

/**
 * Posicao do Top 10: numero e poster como uma composicao unica.
 *
 * Tudo deriva de uma variavel — a largura do poster. O numero e dimensionado
 * como multiplo dela, e a area visivel a esquerda tambem, entao a sobreposicao
 * fica identica em qualquer tela e nao ha um so valor fixo a manter.
 *
 * A altura do algarismo e calculada para bater com a altura do poster: Bebas
 * Neue tem cap-height de ~0,73 do font-size, entao `altura do poster / 0,73`
 * da um numero que ocupa a composicao inteira, e nao um selo ao lado da capa.
 *
 * O poster fica na frente e cobre a metade direita do algarismo. So contorno no
 * numero, sem preenchimento: solido, ele competiria com a arte da capa. O
 * contorno e fino e dessaturado de proposito — ele marca a posicao, nao disputa
 * atencao com a capa.
 *
 * O hover move a composicao inteira (numero + poster), nao so a capa: sao uma
 * peca so, e animar apenas metade quebraria a sobreposicao.
 */
export function RankCard({ rank, id, tipo, titulo, poster, urlDub, urlLeg, isNew }: Props) {
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;

  // Dois digitos precisam de mais espaco a esquerda para nao ficarem cortados.
  const faixaNumero = rank >= 10 ? "1.02" : "0.54";

  return (
    <Link
      href={href}
      title={titulo}
      aria-label={`${rank}. ${titulo}`}
      className="group/card relative z-0 flex-none hover:z-20 focus-visible:z-20"
      style={
        {
          "--pw": "clamp(146px, 14.5vw, 220px)",
          width: `calc(var(--pw) * (1 + ${faixaNumero}))`,
        } as React.CSSProperties
      }
    >
      <div
        className="relative origin-bottom transition-transform duration-300 ease-out will-change-transform group-hover/card:-translate-y-1.5 group-hover/card:scale-[1.06] group-focus-visible/card:-translate-y-1.5 group-focus-visible/card:scale-[1.06]"
        style={{ height: "calc(var(--pw) * 1.5)" }}
      >

        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 select-none font-black leading-none"
          style={{
            fontFamily: "var(--font-bebas), 'Bebas Neue', Impact, 'Arial Black', sans-serif",
            fontSize: "calc(var(--pw) * 1.5 / 0.73)",
            // Preenchimento na cor do fundo do site, nao transparente: o
            // algarismo tapa o que passa atras dele e vira um recorte solido,
            // como na referencia. So o contorno fino o desenha.
            color: "#18181B",
            WebkitTextStroke: "clamp(0.75px, 0.075vw, 1.1px) rgba(150,150,158,0.75)",
            lineHeight: 0.73,
            letterSpacing: rank >= 10 ? "-0.06em" : "normal",
          }}
        >
          {rank}
        </span>

        <div
          className="absolute bottom-0 right-0 overflow-hidden rounded-lg bg-zinc-800 shadow-[0_6px_20px_rgba(0,0,0,0.55)] transition-shadow duration-300 ease-out group-hover/card:shadow-[0_18px_44px_rgba(0,0,0,0.8)]"
          style={{ width: "var(--pw)", height: "calc(var(--pw) * 1.5)" }}
        >
          <Image
            src={poster ? imgUrl(poster, "w500") : "/placeholder.jpg"}
            alt={titulo}
            fill
            className="object-cover"
            // Teto de 220px em tela 2x pede ~440px: w500 e o degrau do TMDB
            // acima disso, sem estourar a banda.
            sizes="(max-width: 768px) 150px, 220px"
            loading="lazy"
            onError={imgFallback}
          />

          {isNew && (
            <span className="absolute bottom-1.5 left-1.5 rounded bg-red-600 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-white">
              Novo
            </span>
          )}
          {!isNew && urlDub && (
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white backdrop-blur">
              DUB
            </span>
          )}
          {!isNew && !urlDub && urlLeg && (
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white backdrop-blur">
              LEG
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
