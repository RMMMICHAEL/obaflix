"use client";

import Image from "next/image";
import Link from "next/link";
import { Play } from "lucide-react";
import { imgUrl } from "@/lib/tmdb";

function imgFallback(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.currentTarget as HTMLImageElement).src = "/placeholder.jpg";
}

interface Props {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  background?: string | null;
  logo?: string | null;
  ano: number | null;
  nota: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  progresso?: { progressoSeg: number; duracaoSeg: number | null } | null;
  episodeLabel?: string | null;
  isNew?: boolean;
}

/**
 * Card das prateleiras comuns: banner horizontal, sem texto permanente.
 *
 * O componente se chamava LandscapeCard mas renderizava `aspect-[2/3]` — um
 * poster vertical estreito — com titulo, nota e ano fixos embaixo. Numa tela
 * larga isso empilhava capa, texto, badges e a fileira seguinte no mesmo campo
 * de visao, e a home lia como catalogo, nao como vitrine.
 *
 * Agora a arte conduz sozinha: 16:9, poucos itens grandes por fileira, e os
 * metadados so aparecem na interacao. Poster vertical fica exclusivo do Top 10,
 * onde ele compoe com o numero.
 */
export function LandscapeCard({
  id, tipo, titulo, poster, background, logo, ano, nota,
  urlDub, urlLeg, progresso, episodeLabel, isNew,
}: Props) {
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;

  // O backdrop e a imagem certa para 16:9. O poster so entra como ultimo
  // recurso: recortado no meio, ele perde justamente o enquadramento que
  // identifica o titulo.
  const bgSrc = background ? imgUrl(background, "w780") : poster ? imgUrl(poster, "w342") : "/placeholder.jpg";
  const logoSrc = logo ? imgUrl(logo, "w300") : null;

  // Larguras calibradas para 5 a 7 cards visiveis no desktop: ~5 em 1280px e
  // ~6,6 em 1920px. Cards mais largos que isso derrubam a contagem para 4 e a
  // fileira perde a leitura de vitrine.
  const pct = progresso?.duracaoSeg
    ? Math.min((progresso.progressoSeg / progresso.duracaoSeg) * 100, 100)
    : 0;

  return (
    <div className="relative group/card shrink-0 w-[200px] sm:w-[210px] md:w-[220px] 2xl:w-[260px]">
      <Link href={href} title={titulo}>
        <div className="relative aspect-video rounded-lg overflow-hidden bg-zinc-900 cursor-pointer transition-transform duration-200 ease-out group-hover/card:scale-[1.03]">

          <Image
            src={bgSrc}
            alt={titulo}
            fill
            className="w-full h-full object-cover"
            sizes="(max-width: 640px) 200px, (max-width: 768px) 210px, (max-width: 1536px) 220px, 260px"
            loading="lazy"
            onError={imgFallback}
          />

          {/* O logo oficial identifica melhor que texto do app, e boa parte do
              acervo tem versao pt-BR. Sem logo, o titulo entra no hover. */}
          {logoSrc && (
            <>
              <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 flex items-end justify-start p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoSrc}
                  alt={titulo}
                  className="max-w-[62%] max-h-[42%] object-contain object-left drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]"
                />
              </div>
            </>
          )}

          {/* Titulo so na interacao. No toque nao ha hover, entao ele fica
              visivel no mobile — sem isso o card ficaria anonimo ali. */}
          {!logoSrc && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2.5 pt-8 md:opacity-0 md:group-hover/card:opacity-100 transition-opacity duration-200">
              <p className="text-[13px] font-medium text-white truncate">{titulo}</p>
            </div>
          )}

          <div className="absolute inset-0 hidden md:flex items-center justify-center opacity-0 group-hover/card:opacity-100 transition-opacity duration-200">
            <div className="w-11 h-11 rounded-full bg-white/90 flex items-center justify-center">
              <Play size={18} fill="black" className="text-black ml-0.5" />
            </div>
          </div>

          {/* Um badge por vez. Nota, ano e DUB/LEG saem do card fechado: eram
              quatro informacoes disputando espaco com a arte. */}
          {episodeLabel ? (
            <span className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-semibold text-white bg-black/70 backdrop-blur">
              {episodeLabel}
            </span>
          ) : isNew ? (
            <span className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider text-emerald-300 bg-emerald-500/20 backdrop-blur">
              NOVO
            </span>
          ) : null}

          {pct > 0 && (
            <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/20">
              <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </Link>
    </div>
  );
}
