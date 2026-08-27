"use client";

import Image from "next/image";
import Link from "next/link";
import { Play } from "lucide-react";
import { imgUrl, logoUrl } from "@/lib/tmdb";

function imgFallback(e: React.SyntheticEvent<HTMLImageElement>) {
  (e.currentTarget as HTMLImageElement).src = "/placeholder.jpg";
}

interface Props {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  poster: string | null;
  background?: string | null;
  /** Logo oficial do TMDB. Quando existe, e ele o nome do card. */
  logo?: string | null;
  ano?: number | null;
  nota?: number | null;
  urlDub?: string | null;
  urlLeg?: string | null;
  progresso?: { progressoSeg: number; duracaoSeg: number | null } | null;
  episodeLabel?: string | null;
  isNew?: boolean;
  /**
   * "row"  = prateleira horizontal (largura fixa, nao encolhe).
   * "grid" = grade (ocupa a celula inteira).
   * Um componente so para os dois casos: duplicar o card era o caminho mais
   * curto para as duas versoes divergirem no primeiro ajuste de estilo.
   */
  layout?: "row" | "grid";
  /** Quando o chamador ja desenha o proprio rotulo. */
  hideTitle?: boolean;
}

/**
 * Card das prateleiras: banner 16:9 com o nome desenhado por cima.
 *
 * O nome sai do logo oficial do TMDB quando ele existe — 74% dos filmes e 81%
 * das series do catalogo — e cai para texto quando nao existe. Os dois ocupam
 * a MESMA area segura, no mesmo canto, entao a estrutura do card nao muda entre
 * um caso e outro e a fileira fica alinhada. Nao ha rotulo abaixo do card: era
 * ele que fazia cards vizinhos terem alturas diferentes.
 *
 * Duas travas que existem por causa de tentativas anteriores:
 *
 * 1. O logo ja esteve aqui e foi removido porque aparecia sobre backdrop que
 *    ja trazia o titulo desenhado — o nome saia duas vezes na mesma imagem.
 *    Por isso `pickBackdrop` volta a escolher sempre arte limpa
 *    (iso_639_1 = null). Se aquela prioridade mudar, este card quebra junto.
 *
 * 2. A area segura tem largura E altura definidas em percentual do banner, que
 *    por sua vez tem altura real vinda do `aspect-video`. A versao antiga usava
 *    `max-h` em percentual contra um pai de altura automatica, e os logos
 *    apareciam de 17% a 146% do tamanho pretendido.
 *
 * A caixa fixa com `object-contain` da conta da variacao de forma dos logos,
 * que vai de 0,8:1 a 16,9:1 (medido em 240 titulos): o wordmark largo encosta
 * na largura, o emblema quadrado encosta na altura, e nenhum estoura.
 */
export function LandscapeCard({
  id, tipo, titulo, poster, background, logo, progresso, episodeLabel, isNew,
  layout = "row", hideTitle = false,
}: Props) {
  const isGrid = layout === "grid";
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;

  // O backdrop e a imagem certa para 16:9. O poster so entra como ultimo
  // recurso: recortado no meio, ele perde justamente o enquadramento que
  // identifica o titulo.
  const bgSrc = background ? imgUrl(background, "w780") : poster ? imgUrl(poster, "w342") : "/placeholder.jpg";
  const logoSrc = logo ? logoUrl(logo, "w300") : null;

  const pct = progresso?.duracaoSeg
    ? Math.min((progresso.progressoSeg / progresso.duracaoSeg) * 100, 100)
    : 0;

  return (
    // Largura fluida em vez de degraus fixos: o card cresce junto com a tela e
    // nao salta de tamanho no breakpoint. 230px de piso mantem o banner legivel
    // no celular; 320px de teto evita que em monitor grande sobrem tres cards
    // gigantes por fileira.
    <div
      className={`relative group/card ${
        isGrid ? "w-full min-w-0" : "shrink-0 w-[clamp(230px,21vw,320px)]"
      }`}
    >
      <Link href={href} title={titulo}>
        <div className="relative aspect-video rounded-lg overflow-hidden bg-zinc-900 cursor-pointer transition-transform duration-200 ease-out group-hover/card:scale-[1.03]">

          <Image
            src={bgSrc}
            alt={titulo}
            fill
            className="w-full h-full object-cover"
            // O teto de 320px em tela 2x pede 640px de imagem: w780 e o degrau
            // imediatamente acima no TMDB. Subir para w1280 dobraria o peso sem
            // ganho visivel.
            sizes={
              isGrid
                ? "(max-width: 640px) 46vw, (max-width: 1024px) 31vw, (max-width: 1536px) 23vw, 320px"
                : "(max-width: 768px) 230px, (max-width: 1536px) 21vw, 320px"
            }
            loading="lazy"
            onError={imgFallback}
          />

          {/* O gradiente voltou porque agora ha nome sobre a arte. Cobre so a
              metade de baixo, que e onde ele vive. */}
          {!hideTitle && (
            <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 via-black/35 to-transparent pointer-events-none" />
          )}

          <div className="absolute inset-0 hidden md:flex items-center justify-center opacity-0 group-hover/card:opacity-100 transition-opacity duration-200">
            <div className="w-11 h-11 rounded-full bg-white/90 flex items-center justify-center">
              <Play size={18} fill="black" className="text-black ml-0.5" />
            </div>
          </div>

          {/* Area segura do nome: a mesma caixa serve para logo e para texto. */}
          {!hideTitle && (
            <div className="absolute left-[5%] bottom-[7%] w-[58%] h-[30%] flex items-end pointer-events-none">
              {logoSrc ? (
                <div className="relative w-full h-full">
                  <Image
                    src={logoSrc}
                    alt={titulo}
                    fill
                    // `contain` preserva a proporcao original; ancorar embaixo e
                    // a esquerda mantem a linha de base igual em todos os cards,
                    // mesmo com logos de alturas muito diferentes.
                    className="object-contain object-left-bottom drop-shadow-[0_2px_6px_rgba(0,0,0,0.65)]"
                    sizes="(max-width: 768px) 140px, 190px"
                    loading="lazy"
                  />
                </div>
              ) : (
                <span className="text-white font-semibold leading-tight line-clamp-2 text-[clamp(13px,1.15vw,17px)] drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]">
                  {titulo}
                </span>
              )}
            </div>
          )}

          {/* Um badge por vez, sempre no canto oposto ao nome. */}
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
