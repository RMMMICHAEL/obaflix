import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import Image from "next/image";
import Link from "next/link";
import { ChevronRight, Play, Star } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { ORDEM_POPULARIDADE } from "@/lib/ranking";
import { imgUrl } from "@/lib/tmdb";
import { AndroidContinueWatching } from "@/components/android/AndroidContinueWatching";
import { HeroSlider } from "@/components/ui/HeroSlider";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { LazyRow } from "@/components/ui/LazyRow";
import { EpisodioRecenteRow, type EpisodioRecenteItem } from "@/components/ui/EpisodioRecenteRow";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getContinueWatchingItems } from "@/lib/continue-watching";
import {
  getImdbTop250Showcases,
  getRecentSeriesEpisodes,
} from "@/lib/catalog-showcases";
import { BUSCA, NEW_EP_MS, POR_TRILHA, dedupeAndroid, paraHero, paraTrilha, type TipoCard } from "@/lib/androidHome";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Obaflix para Android",
  description: "Catálogo Obaflix otimizado para celulares e tablets Android.",
  alternates: { canonical: "/android" },
  robots: { index: false, follow: true },
};

// Tipos ainda usados pelos componentes legados abaixo; a renderização da Home
// passa a usar os componentes compartilhados do projeto.
type AndroidItem = { id: string; tipo: "filme" | "serie" | "anime" | "desenho"; titulo: string; sinopse?: string | null; poster: string | null; background: string | null; ano: number | null; nota: number | null; dub?: boolean; leg?: boolean };
type AndroidEpisode = { id: string; serieId: string; serieTitulo: string; titulo: string | null; thumbnail: string | null; poster: string | null; temporada: number; numeroEp: number; isNew: boolean };

const filmSelect = {
  id: true, tmdbId: true, titulo: true, sinopse: true, poster: true, background: true,
  logo: true, ano: true, nota: true, createdAt: true, urlDub: true, urlLeg: true,
} as const;

const seriesSelect = {
  id: true, tmdbId: true, titulo: true, sinopse: true, poster: true, background: true,
  logo: true, ano: true, nota: true, tipo: true, createdAt: true,
} as const;

// A ordenação vive em @/lib/ranking: era esta cópia, mais três iguais, que
// deixavam site, aplicativo e TV com listas diferentes. O `take` continua menor
// aqui de propósito — a ordem canônica é total, então pedir menos devolve um
// prefixo da MESMA lista, não outra lista.

/**
 * Catalogo da /android: identico para todo usuario, entao vive em cache
 * compartilhado em vez de ser refeito a cada visita.
 *
 * A pagina e `force-dynamic` porque checa sessao e monta "continuar
 * assistindo", mas isso nao obrigava as seis consultas de catalogo a rodarem
 * junto — elas nao dependem de quem esta olhando. Sao ~5 mil queries por dia
 * de tráfego moderado trocadas por 6 a cada 5 minutos.
 *
 * As datas dos episodios sao consumidas AQUI DENTRO de proposito: o
 * unstable_cache serializa o retorno em JSON, e um `Date` volta como string.
 * Fazer `createdAt.getTime()` depois do cache quebraria na segunda visita.
 * Sair daqui com `isNew` ja resolvido em booleano evita a armadilha; a janela
 * e de 48h, entao os 5 minutos de defasagem nao mudam nada.
 */
const getCatalogoAndroid = unstable_cache(
  async () => {
    const [destaques, recentes, series, animes, desenhos, imdbTop250, episodios] = await Promise.all([
      prisma.filme.findMany({
        where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
        orderBy: ORDEM_POPULARIDADE,
        take: 8,
        select: filmSelect,
      }),
      prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: BUSCA, select: filmSelect }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: ORDEM_POPULARIDADE, take: BUSCA, select: seriesSelect }),
      prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: ORDEM_POPULARIDADE, take: BUSCA, select: seriesSelect }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: ORDEM_POPULARIDADE, take: BUSCA, select: seriesSelect }),
      getImdbTop250Showcases(),
      getRecentSeriesEpisodes(),
    ]);

    const agora = Date.now();
    const episodeItems: EpisodioRecenteItem[] = episodios.slice(0, POR_TRILHA).map((episodio) => ({
      episodioId: episodio.id, serieId: episodio.serieId, titulo: episodio.titulo,
      serieTitulo: episodio.serieTitulo, poster: episodio.seriePoster, thumbnail: episodio.thumbnail,
      temporada: episodio.temporada, numeroEp: episodio.numeroEp,
      tipo: (episodio.serieTipo ?? "serie") as "serie" | "anime" | "desenho",
      isNovoEpisodio: agora - new Date(episodio.atualizadoEm).getTime() < NEW_EP_MS,
      dub: episodio.dub, leg: episodio.leg,
    }));
    const trilha = (linhas: any[], tipo: TipoCard) =>
      dedupeAndroid(linhas).slice(0, POR_TRILHA)
        .map((linha) => paraTrilha(linha, tipo));
    const heroItems = paraHero(dedupeAndroid(destaques));

    return {
      heroItems, movies: trilha(recentes, "filme"), series: trilha(series, "serie"),
      topMovies: imdbTop250.filmes.map((item) => paraTrilha(item, "filme")),
      topSeries: imdbTop250.series.map((item) => paraTrilha(item, "serie")),
      animeItems: trilha(animes, "anime"), cartoonItems: trilha(desenhos, "desenho"),
      episodeItems,
    };
  },
  // v2: o formato mudou (dub/leg em vez de urlDub/urlLeg). Sem trocar a chave, o
  // cache continuaria servindo objetos antigos com a URL do provedor dentro.
  ["android-catalogo-v3"],
  { revalidate: 300, tags: ["android-catalogo"] },
);

function MediaRail({ title, href, items }: { title: string; href: string; items: AndroidItem[] }) {
  if (!items.length) return null;

  return (
    <section className="android-rail" aria-labelledby={`rail-${title.replace(/\s/g, "-").toLowerCase()}`}>
      <div className="android-section-heading">
        <h2 id={`rail-${title.replace(/\s/g, "-").toLowerCase()}`}>{title}</h2>
        <Link href={href} aria-label={`Ver todos em ${title}`}>
          Ver todos <ChevronRight size={16} />
        </Link>
      </div>
      <div className="android-rail-track">
        {items.map((item) => {
          const detailHref = item.tipo === "filme" ? `/filme/${item.id}` : `/serie/${item.id}`;
          return (
            <Link className="android-poster" href={detailHref} key={`${item.tipo}-${item.id}`}>
              <div className="android-poster-art">
                <Image
                  src={item.background ? imgUrl(item.background, "w780") : item.poster ? imgUrl(item.poster, "w342") : "/placeholder.jpg"}
                  alt=""
                  fill
                  sizes="(max-width: 480px) 58vw, 260px"
                />
                {item.dub && <span className="android-audio-badge">DUB</span>}
              </div>
              <strong>{item.titulo}</strong>
              <span className="android-poster-meta">
                {item.ano ?? "Obaflix"}
                {item.nota ? <><Star size={10} fill="currentColor" /> {item.nota.toFixed(1)}</> : null}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function EpisodeRail({ items }: { items: AndroidEpisode[] }) {
  if (!items.length) return null;

  return (
    <section className="android-rail" aria-labelledby="android-new-episodes-title">
      <div className="android-section-heading">
        <h2 id="android-new-episodes-title">Episódios Recentes</h2>
        <Link href="/series" aria-label="Ver todas as séries">
          Ver séries <ChevronRight size={16} />
        </Link>
      </div>
      <div className="android-wide-track">
        {items.map((item) => (
          <Link
            className="android-episode-card"
            href={`/assistir/serie/${item.serieId}/t${item.temporada}/ep${item.numeroEp}`}
            key={item.id}
          >
            <div className="android-episode-art">
              <Image
                src={item.thumbnail ? imgUrl(item.thumbnail, "w500") : item.poster ? imgUrl(item.poster, "w342") : "/placeholder-bg.jpg"}
                alt=""
                fill
                sizes="(max-width: 480px) 66vw, 300px"
              />
              <span className="android-episode-index">T{item.temporada} E{item.numeroEp}</span>
              {item.isNew && <span className="android-new-badge">Novo</span>}
              <span className="android-episode-play"><Play size={18} fill="currentColor" /></span>
            </div>
            <strong>{item.serieTitulo}</strong>
            <span>{item.titulo || `Episódio ${item.numeroEp}`}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function AndroidHomePage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login?callbackUrl=%2Fandroid");

  const [catalogo, continueItems] = await Promise.all([
    getCatalogoAndroid(),
    getContinueWatchingItems(userId),
  ]);
  const { heroItems, movies, series, topMovies, topSeries, animeItems, cartoonItems, episodeItems } = catalogo;

  if (heroItems.length === 0 && movies.length === 0 && series.length === 0) {
    return (
      <div className="android-home android-empty-state">
        <span>OBAFLIX</span>
        <h1>O catálogo está sendo preparado</h1>
        <p>Volte em alguns instantes para começar a assistir.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-12">
      {heroItems.length > 0 && <HeroSlider items={heroItems} />}
      <div className={`mt-3 ${!heroItems.length ? "pt-20" : ""}`}>
        <AndroidContinueWatching initialItems={continueItems} />
        <EpisodioRecenteRow titulo="Episódios Recentes" items={episodeItems} />
        <LandscapeRow titulo="Adicionados Recentemente" items={movies} verTodosHref="/filmes" />
        <LandscapeRow titulo="Séries para Maratonar" items={series} verTodosHref="/series" />
        <LazyRow><LandscapeRow titulo="Filmes Mais Bem Avaliados" items={topMovies} verTodosHref="/melhores" /></LazyRow>
        <LazyRow><LandscapeRow titulo="Séries Mais Bem Avaliadas" items={topSeries} verTodosHref="/melhores" /></LazyRow>
        <LazyRow><LandscapeRow titulo="Animes em Alta" items={animeItems} verTodosHref="/animes" /></LazyRow>
        <LazyRow><LandscapeRow titulo="Para Toda a Família" items={cartoonItems} verTodosHref="/desenhos" /></LazyRow>
      </div>
    </div>
  );
}
