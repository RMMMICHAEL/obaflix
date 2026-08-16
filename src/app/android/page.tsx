import type { Metadata } from "next";
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
  urlDub?: string | null;
  urlLeg?: string | null;
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
                  src={item.poster ? imgUrl(item.poster, "w342") : "/placeholder.jpg"}
                  alt=""
                  fill
                  sizes="(max-width: 480px) 35vw, 168px"
                />
                {item.urlDub && <span className="android-audio-badge">DUB</span>}
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

  const filmSelect = {
    id: true, titulo: true, sinopse: true, poster: true, background: true,
    ano: true, nota: true, urlDub: true, urlLeg: true,
  } as const;
  const seriesSelect = {
    id: true, titulo: true, sinopse: true, poster: true, background: true,
    ano: true, nota: true, tipo: true,
  } as const;

  const [featuredMovies, recentMovies, popularSeries, animes, desenhos, recentEpisodes, continueItems] = await Promise.all([
    prisma.filme.findMany({
      where: { OR: [{ urlDub: { not: null } }, { urlLeg: { not: null } }] },
      orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
      take: 8,
      select: filmSelect,
    }),
    prisma.filme.findMany({ orderBy: { createdAt: "desc" }, take: 18, select: filmSelect }),
    prisma.serie.findMany({
      where: { tipo: "serie" },
      orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
      take: 18,
      select: seriesSelect,
    }),
    prisma.serie.findMany({
      where: { tipo: "anime" },
      orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
      take: 18,
      select: seriesSelect,
    }),
    prisma.serie.findMany({
      where: { tipo: "desenho" },
      orderBy: [{ popularidade: { sort: "desc", nulls: "last" } }, { nota: "desc" }],
      take: 18,
      select: seriesSelect,
    }),
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
    userId ? getContinueWatchingItems(userId) : Promise.resolve([]),
  ]);

  const hero = featuredMovies[0];
  const movies: AndroidItem[] = recentMovies.map((item) => ({ ...item, tipo: "filme" }));
  const series: AndroidItem[] = popularSeries.map((item) => ({ ...item, tipo: "serie" }));
  const animeItems: AndroidItem[] = animes.map((item) => ({ ...item, tipo: "anime" }));
  const cartoonItems: AndroidItem[] = desenhos.map((item) => ({ ...item, tipo: "desenho" }));
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
          src={hero.background ? imgUrl(hero.background, "original") : hero.poster ? imgUrl(hero.poster, "w780") : "/placeholder-bg.jpg"}
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
            {hero.urlDub && <span className="android-quality-pill">Dublado</span>}
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
