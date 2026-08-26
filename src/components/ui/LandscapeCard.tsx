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
  /** Arte ja traz o titulo desenhado em portugues: o rotulo abaixo some. */
  backgroundTituloPt?: boolean | null;
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
  /** Quando o chamador ja desenha o proprio rotulo abaixo do card. */
  hideTitle?: boolean;
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
// `logo`, `ano`, `nota`, `urlDub` e `urlLeg` seguem na interface porque os
// chamadores repassam o item inteiro por spread, mas nao sao mais desenhados no
// card fechado: a arte e o nome bastam, e o resto vai para a interacao.
export function LandscapeCard({
  id, tipo, titulo, poster, background, backgroundTituloPt, progresso, episodeLabel, isNew,
  layout = "row", hideTitle = false,
}: Props) {
  const isGrid = layout === "grid";
  const href = tipo === "filme" ? `/filme/${id}` : `/serie/${id}`;

  // O backdrop e a imagem certa para 16:9. O poster so entra como ultimo
  // recurso: recortado no meio, ele perde justamente o enquadramento que
  // identifica o titulo.
  const bgSrc = background ? imgUrl(background, "w780") : poster ? imgUrl(poster, "w342") : "/placeholder.jpg";

  // Larguras calibradas para 5 a 7 cards visiveis no desktop: ~5 em 1280px e
  // ~6,6 em 1920px. Cards mais largos que isso derrubam a contagem para 4 e a
  // fileira perde a leitura de vitrine.
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

          {/* Sem gradiente e sem texto por cima da arte: o nome vive abaixo do
              card, ou ja vem desenhado no proprio banner. Escurecer a imagem so
              serviria para dar contraste a um texto que nao esta aqui. */}

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

        {/* Nome abaixo do banner. Uma linha so: com duas, fileiras vizinhas
            ficam com alturas diferentes conforme o tamanho do titulo e o ritmo
            da pagina quebra.

            Quando a arte ja traz o titulo desenhado em portugues, a linha
            continua ocupando o mesmo espaco mas fica invisivel. Remove-la de
            vez faria os cards da mesma fileira terem alturas diferentes, e a
            prateleira fica desalinhada justamente porque so parte do catalogo
            tem arte legendada. O nome segue acessivel pelo alt da imagem e pelo
            title do link. */}
        {!hideTitle && (
          <p
            aria-hidden={backgroundTituloPt ? "true" : undefined}
            className={`mt-2 px-0.5 text-[13px] md:text-sm text-zinc-300 truncate transition-colors ${
              backgroundTituloPt ? "invisible" : "group-hover/card:text-white"
            }`}
          >
            {titulo}
          </p>
        )}
      </Link>
    </div>
  );
}
