"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronDown, Play } from "lucide-react";
import { imgUrl, logoUrl } from "@/lib/tmdb";
import { useEstadoPessoal } from "./EstadoPessoal";
import { MediaHeroActions } from "./MediaHeroActions";
import { TrailerButton } from "./TrailerButton";

export interface MediaHeroProps {
  conteudoId: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  tituloOriginal?: string | null;
  /** Caminho do TMDB (/abc.jpg) ou URL completa. */
  backdrop?: string | null;
  /** Logo PNG transparente. Caminho do TMDB ou URL completa. */
  logo?: string | null;
  sinopse?: string | null;
  ano?: number | null;
  /** Classificacao indicativa brasileira: "L", "10", "12", "14", "16" ou "18". */
  certificacao?: string | null;
  nota?: number | null;
  imdbId?: string | null;
  /** Filmes: duracao em minutos. */
  duracaoMin?: number | null;
  /** Series/animes/desenhos: quantidade de temporadas. */
  temporadas?: number | null;
  top250?: number | null;
  vip?: boolean;
  generos?: { id: number; nome: string }[];
  watchHref?: string | null;
  watchLabel?: string;
  trailerKey?: string | null;
  dub?: boolean;
  leg?: boolean;
  shareUrl: string;
}

// Cores oficiais da ClassInd — o selo so comunica se a cor bater com a faixa.
const CERT_COLORS: Record<string, string> = {
  L: "#0F8A3C",
  "10": "#0B69C7",
  "12": "#E0B000",
  "14": "#E07B1E",
  "16": "#D02222",
  "18": "#1A1A1A",
};

const SINOPSE_LONGA = 240;

export function MediaHero({
  conteudoId,
  tipo,
  titulo,
  tituloOriginal,
  backdrop,
  logo,
  sinopse,
  ano,
  certificacao,
  nota,
  imdbId,
  duracaoMin,
  temporadas,
  top250,
  vip = false,
  generos = [],
  watchHref,
  watchLabel = "Assistir",
  trailerKey,
  dub = false,
  leg = false,
  shareUrl,
}: MediaHeroProps) {
  const [expandida, setExpandida] = useState(false);

  // O HTML desta pagina e cacheado e igual para todo mundo, entao "continuar
  // assistindo" nao pode vir do servidor: chega aqui depois da hidratacao.
  //
  // Sem skeleton no rotulo de proposito: o HTML cacheado e o mesmo servido para
  // quem esta deslogado e para o crawler, e um placeholder pulsante deixaria o
  // botao sem texto para eles. Melhor o rotulo neutro e uma troca so.
  const { continuar } = useEstadoPessoal();
  const retomandoEpisodio = continuar?.temporada != null && continuar?.numeroEp != null;
  const rotuloFinal = retomandoEpisodio
    ? `Continuar T${continuar!.temporada} E${continuar!.numeroEp}`
    : continuar
      ? "Continuar assistindo"
      : watchLabel;
  const hrefFinal = retomandoEpisodio
    ? `/assistir/serie/${conteudoId}/t${continuar!.temporada}/ep${continuar!.numeroEp}`
    : watchHref;

  const bgSrc = backdrop ? imgUrl(backdrop, "original") : "/placeholder-bg.jpg";
  const logoSrc = logoUrl(logo, "w500");
  const podeExpandir = (sinopse?.length ?? 0) > SINOPSE_LONGA;

  const duracaoLabel = duracaoMin
    ? duracaoMin >= 60
      ? `${Math.floor(duracaoMin / 60)}h ${duracaoMin % 60}min`
      : `${duracaoMin}min`
    : null;
  const temporadasLabel = temporadas
    ? `${temporadas} ${temporadas === 1 ? "temporada" : "temporadas"}`
    : null;

  const meta: React.ReactNode[] = [];

  if (certificacao) {
    meta.push(
      <span
        key="cert"
        title={`Classificação indicativa: ${certificacao === "L" ? "livre" : `${certificacao} anos`}`}
        className="grid h-6 min-w-[1.5rem] place-items-center rounded px-1 text-[11px] font-black leading-none text-white ring-1 ring-white/20"
        style={{ backgroundColor: CERT_COLORS[certificacao] ?? "#3F3F46" }}
      >
        {certificacao}
      </span>
    );
  }

  if (nota) {
    const selo = (
      <span className="flex items-center gap-1.5">
        <span className="rounded-[3px] bg-[#F5C518] px-1.5 py-[3px] text-[10px] font-black leading-none tracking-tight text-black">
          IMDb
        </span>
        <span className="font-semibold text-white">{nota.toFixed(1)}</span>
      </span>
    );
    meta.push(
      imdbId ? (
        <a
          key="nota"
          href={`https://www.imdb.com/title/${imdbId}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="transition-opacity hover:opacity-80"
        >
          {selo}
        </a>
      ) : (
        <span key="nota">{selo}</span>
      )
    );
  }

  if (ano) meta.push(<span key="ano">{ano}</span>);
  if (duracaoLabel) meta.push(<span key="dur">{duracaoLabel}</span>);
  if (temporadasLabel) meta.push(<span key="temp">{temporadasLabel}</span>);

  if (top250) {
    meta.push(
      <span
        key="top"
        className="rounded bg-amber-500/15 px-2 py-[3px] text-[10px] font-black uppercase tracking-wider text-amber-400 ring-1 ring-amber-400/30"
      >
        Top {top250}
      </span>
    );
  }

  if (vip) {
    meta.push(
      <span
        key="vip"
        className="rounded bg-gradient-to-r from-amber-400 to-yellow-500 px-2 py-[3px] text-[10px] font-black uppercase tracking-wider text-black"
      >
        VIP
      </span>
    );
  }

  if (dub) {
    meta.push(
      <span key="dub" className="rounded bg-white/10 px-2 py-[3px] text-[10px] font-bold tracking-wider text-zinc-200 ring-1 ring-white/15">
        DUB
      </span>
    );
  }

  if (leg) {
    meta.push(
      <span key="leg" className="rounded bg-white/10 px-2 py-[3px] text-[10px] font-bold tracking-wider text-zinc-200 ring-1 ring-white/15">
        LEG
      </span>
    );
  }

  return (
    <section className="relative isolate w-full overflow-hidden">
      {/*
        Camada de imagem. No mobile ela ocupa uma faixa 3:2 no topo — assim o
        recorte lateral fica em ~9% de cada lado, em vez dos 60%+ que um
        object-cover de tela cheia comeria de um backdrop 16:9. Do md pra cima
        ela preenche o hero inteiro.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 aspect-[3/2] sm:aspect-video md:inset-0 md:aspect-auto">
        <Image
          src={bgSrc}
          alt=""
          aria-hidden="true"
          fill
          sizes="100vw"
          priority
          className="object-cover object-top md:object-center"
        />

        {/* Degrade inferior: e ele que funde a imagem com o resto da pagina. */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(to top, #09090b 0%, rgba(9,9,11,0.94) 14%, rgba(9,9,11,0.6) 38%, rgba(9,9,11,0.18) 64%, rgba(9,9,11,0) 88%)",
          }}
        />

        {/* Degrade lateral esquerdo: da contraste pro logo e pro texto. */}
        <div
          className="absolute inset-0 hidden md:block"
          style={{
            backgroundImage:
              "linear-gradient(to right, #09090b 0%, rgba(9,9,11,0.86) 20%, rgba(9,9,11,0.45) 46%, rgba(9,9,11,0) 76%)",
          }}
        />

        {/* Scrim no topo: a navbar e transparente e some sobre imagens claras. */}
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-zinc-950/85 to-transparent md:h-32" />
      </div>

      {/*
        No mobile a altura sai do conteudo: o padding-top posiciona o logo sobre
        o terco final da imagem. Do md pra cima o hero ganha altura fixa e o
        bloco desce pro rodape, que e onde a referencia ancora tudo.
      */}
      <div className="relative z-10 flex flex-col px-4 pb-10 pt-[40vw] sm:pt-[36vw] md:min-h-[min(86vh,860px)] md:justify-end md:px-14 md:pb-16 md:pt-40">
        {/* Logo oficial em PNG transparente — ou o titulo estilizado no lugar. */}
        <h1 className="mb-4 md:mb-5">
          {logoSrc ? (
            <>
              {/* O logo carrega a marca do titulo em imagem. O texto vai no span
                  para o h1 existir como texto na pagina, e nao so como alt — por
                  isso a imagem fica decorativa e o titulo nao e lido duas vezes. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logoSrc}
                alt=""
                aria-hidden="true"
                className="h-auto max-h-[clamp(4.5rem,15vw,9.5rem)] w-auto max-w-[min(26rem,78vw)] object-contain object-left drop-shadow-[0_6px_28px_rgba(0,0,0,0.75)]"
              />
              <span className="sr-only">{titulo}</span>
            </>
          ) : (
            <span
              className="block max-w-[18ch] bg-gradient-to-b from-white via-white to-zinc-400 bg-clip-text text-[clamp(2.25rem,6.5vw,4.5rem)] font-normal uppercase leading-[0.9] tracking-[0.01em] text-transparent"
              style={{ fontFamily: "var(--font-bebas), Inter, system-ui, sans-serif" }}
            >
              {titulo}
            </span>
          )}
        </h1>

        {tituloOriginal && tituloOriginal !== titulo && (
          <p className="mb-3 text-xs italic tracking-wide text-zinc-400/80">{tituloOriginal}</p>
        )}

        {meta.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-zinc-300 md:mb-5 md:text-sm">
            {meta.map((node, index) => (
              <span key={index} className="flex items-center gap-2.5">
                {index > 0 && (
                  <span className="text-zinc-600" aria-hidden="true">
                    •
                  </span>
                )}
                {node}
              </span>
            ))}
          </div>
        )}

        {sinopse && (
          <div className="mb-4 max-w-[34rem] md:mb-5 md:max-w-[42rem]">
            <p
              className={`text-sm leading-relaxed text-zinc-200/90 md:text-[15px] ${
                podeExpandir && !expandida ? "line-clamp-3" : ""
              }`}
            >
              {sinopse}
            </p>
            {podeExpandir && (
              <button
                type="button"
                onClick={() => setExpandida((v) => !v)}
                aria-expanded={expandida}
                className="mt-1.5 flex items-center gap-1 text-sm font-semibold text-white transition-colors hover:text-zinc-300"
              >
                {expandida ? "Ver menos" : "Ver mais"}
                <ChevronDown size={15} className={`transition-transform ${expandida ? "rotate-180" : ""}`} />
              </button>
            )}
          </div>
        )}

        {generos.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-2 md:mb-7">
            {generos.map((g) => (
              <Link
                key={g.id}
                href={`/genero/${g.id}`}
                className="rounded-full border border-white/10 bg-white/[0.07] px-3 py-1.5 text-xs text-zinc-300 backdrop-blur-sm transition-colors hover:border-white/30 hover:bg-white/15 hover:text-white"
              >
                {g.nome}
              </Link>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {hrefFinal && (
            <Link
              href={hrefFinal}
              className="flex h-12 items-center justify-center gap-2.5 rounded-xl bg-white px-8 text-[15px] font-bold text-black shadow-[0_8px_30px_rgba(0,0,0,0.45)] transition-colors hover:bg-zinc-200 md:h-[3.25rem] md:text-base"
            >
              <Play size={19} fill="black" strokeWidth={0} /> {rotuloFinal}
            </Link>
          )}

          {trailerKey && (
            <TrailerButton
              videoKey={trailerKey}
              titulo={titulo}
              className="flex h-12 items-center justify-center gap-2.5 rounded-xl border border-white/15 bg-white/10 px-7 text-[15px] font-semibold text-white backdrop-blur-sm transition-colors hover:border-white/30 hover:bg-white/20 md:h-[3.25rem]"
            />
          )}

          <MediaHeroActions conteudoId={conteudoId} tipo={tipo} shareUrl={shareUrl} titulo={titulo} />
        </div>
      </div>
    </section>
  );
}
