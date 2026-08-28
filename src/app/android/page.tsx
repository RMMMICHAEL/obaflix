import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import Image from "next/image";
import Link from "next/link";
import { ChevronRight, Play, Star } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { imgUrl } from "@/lib/tmdb";
import { AndroidContinueWatching } from "@/components/android/AndroidContinueWatching";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getContinueWatchingItems } from "@/lib/continue-watching";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Obaflix para Android",
  description: "Catálogo Obaflix otimizado para celulares e tablets Android.",
  alternates: { canonical: "/android" },
  robots: { index: false, follow: true },
};

type AndroidItem = {
  id: string;
  tipo: "filme" | "serie" | "anime" | "desenho";
  titulo: string;
  sinopse?: string | null;
  poster: string | null;
  background: string | null;
  ano: number | null;
  nota: number | null;
  /** Disponibilidade de audio, nunca a URL da fonte. */
  dub?: boolean;
  leg?: boolean;
};

type AndroidEpisode = {
  id: string;
  serieId: string;
  serieTitulo: string;
  titulo: string | null;
  thumbnail: string | null;
  poster: string | null;
  temporada: number;
  numeroEp: number;
  isNew: boolean;
};

const filmSelect = {
  id: true, titulo: true, sinopse: true, poster: true, background: true,
  ano: true, nota: true, urlDub: true, urlLeg: true,
} as const;

const seriesSelect = {
  id: true, titulo: true, sinopse: true, poster: true, background: true,
  ano: true, nota: true, tipo: true,
} as const;

const ordemPopular = [
  { popularidade: { sort: "desc" as const, nulls: "last" as const } },
  { nota: "desc" as const },
];

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
    const [featuredMovies, recentMovies, popularSeries, animes, desenhos, recentEpisodes] = await Promise.all([
      prisma.filme.findMany({
        where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
        orderBy: ordemPopular,
        take: 8,
        select: filmSelect,
      }),
      prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 18, select: filmSelect }),
      prisma.serie.findMany({ where: { tipo: "serie" }, orderBy: ordemPopular, take: 18, select: seriesSelect }),
      prisma.serie.findMany({ where: { tipo: "anime" }, orderBy: ordemPopular, take: 18, select: seriesSelect }),
      prisma.serie.findMany({ where: { tipo: "desenho" }, orderBy: ordemPopular, take: 18, select: seriesSelect }),
      prisma.episodio.findMany({
        orderBy: { createdAt: "desc" },
        take: 28,
        select: {
          id: true,
          serieId: true,
          titulo: true,
          thumbnail: true,
          temporada: true,
          numeroEp: true,
          createdAt: true,
          serie: { select: { titulo: true, poster: true, createdAt: true } },
        },
      }),
    ]);

    const now = Date.now();
    const episodeItems: AndroidEpisode[] = recentEpisodes
      .filter((episode, index, all) => {
        const newSeries = now - episode.serie.createdAt.getTime() < 14 * 24 * 60 * 60 * 1000 || episode.serieId.startsWith("sf_");
        if (!newSeries) return true;
        return !all.some((other, otherIndex) =>
          otherIndex < index &&
          other.serieId === episode.serieId &&
          (other.temporada > episode.temporada ||
            (other.temporada === episode.temporada && other.numeroEp > episode.numeroEp)),
        );
      })
      .slice(0, 18)
      .map((episode) => ({
        id: episode.id,
        serieId: episode.serieId,
        serieTitulo: episode.serie.titulo,
        titulo: episode.titulo,
        thumbnail: episode.thumbnail,
        poster: episode.serie.poster,
        temporada: episode.temporada,
        numeroEp: episode.numeroEp,
        isNew: now - episode.createdAt.getTime() < 48 * 60 * 60 * 1000,
      }));

    // urlDub/urlLeg saem da linha aqui: o catalogo so precisa saber que existe
    // audio, e a URL real do provedor nao pode entrar no HTML nem no cache.
    const semFonte = <T extends { urlDub?: string | null; urlLeg?: string | null }>(
      { urlDub, urlLeg, ...resto }: T,
    ) => ({ ...resto, dub: Boolean(urlDub), leg: Boolean(urlLeg) });

    return {
      hero: featuredMovies[0] ? semFonte(featuredMovies[0]) : null,
      movies: recentMovies.map((item): AndroidItem => ({ ...semFonte(item), tipo: "filme" })),
      series: popularSeries.map((item): AndroidItem => ({ ...item, tipo: "serie" })),
      animeItems: animes.map((item): AndroidItem => ({ ...item, tipo: "anime" })),
      cartoonItems: desenhos.map((item): AndroidItem => ({ ...item, tipo: "desenho" })),
      episodeItems,
    };
  },
  // v2: o formato mudou (dub/leg em vez de urlDub/urlLeg). Sem trocar a chave, o
  // cache continuaria servindo objetos antigos com a URL do provedor dentro.
  ["android-catalogo-v2"],
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
        <h2 id="android-new-episodes-title">Novos episódios</h2>
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
  const { hero, movies, series, animeItems, cartoonItems, episodeItems } = catalogo;

  if (!hero) {
    return (
      <div className="android-home android-empty-state">
        <span>OBAFLIX</span>
        <h1>O catálogo está sendo preparado</h1>
        <p>Volte em alguns instantes para começar a assistir.</p>
      </div>
    );
  }

  return (
    <div className="android-home">
      <section className="android-hero" aria-labelledby="android-featured-title">
        <Image
          // "original" trazia o arquivo cru do TMDB: medido em 1.055 KB contra
          // 98 KB no w1280 — 26x mais peso, com `priority`, na primeira coisa
          // que um celular baixa. Nenhuma tela de telefone ou tablet usa essa
          // resolucao, e com images.unoptimized nao ha redimensionamento.
          src={hero.background ? imgUrl(hero.background, "w1280") : hero.poster ? imgUrl(hero.poster, "w780") : "/placeholder-bg.jpg"}
          alt=""
          fill
          sizes="100vw"
          className="android-hero-image"
          priority
        />
        <div className="android-hero-shade" />
        <div className="android-hero-content">
          <p className="android-eyebrow">Destaque de hoje</p>
          <h1 id="android-featured-title">{hero.titulo}</h1>
          <div className="android-hero-meta">
            {hero.ano && <span>{hero.ano}</span>}
            {hero.nota && <span><Star size={13} fill="currentColor" /> {hero.nota.toFixed(1)}</span>}
            {hero.dub && <span className="android-quality-pill">Dublado</span>}
          </div>
          {hero.sinopse && <p className="android-hero-summary">{hero.sinopse}</p>}
          <div className="android-hero-actions">
            <Link className="android-primary-action" href={`/assistir/filme/${hero.id}`}>
              <Play size={18} fill="currentColor" /> Assistir
            </Link>
            <Link className="android-secondary-action" href={`/filme/${hero.id}`}>
              Detalhes
            </Link>
          </div>
        </div>
      </section>

      <div className="android-catalog">
        <AndroidContinueWatching initialItems={continueItems} />
        <EpisodeRail items={episodeItems} />
        <MediaRail title="Adicionados recentemente" href="/filmes" items={movies} />
        <MediaRail title="Séries para maratonar" href="/series" items={series} />
        <MediaRail title="Animes em alta" href="/animes" items={animeItems} />
        <MediaRail title="Para toda a família" href="/desenhos" items={cartoonItems} />
      </div>
    </div>
  );
}
