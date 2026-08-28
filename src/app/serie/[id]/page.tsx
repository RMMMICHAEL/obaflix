import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  imgUrl,
  getSerie,
  getTVVideos,
  getTVCredits,
  getTVRecommendations,
  getTVSeasonDetails,
  getTVImages,
  getTVCertification,
  pickTrailer,
  pickLogo,
  pickHeroBackdrop,
} from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { EpisodeGrid } from "./EpisodeGrid";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { MediaHero } from "@/components/ui/MediaHero";
import { PeopleRow, type PeopleRowItem } from "@/components/ui/PeopleRow";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { absoluteUrl, mediaMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    select: { titulo: true, sinopse: true, background: true, poster: true, ano: true, tipo: true },
  });
  if (!serie) return { title: "Série não encontrada", robots: { index: false, follow: false } };

  const title = serie.ano ? `${serie.titulo} (${serie.ano})` : serie.titulo;
  const image = serie.background ?? serie.poster;
  return mediaMetadata({
    title,
    description: serie.sinopse,
    path: `/serie/${params.id}`,
    image: image ? imgUrl(image, "original") : null,
    type: "video.tv_show",
  });
}

export default async function SeriePage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id as string | undefined;

  const serie = await prisma.serie.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });

  if (!serie) notFound();

  const [episodios, videos, credits, tmdbDetails, tmdbRecs, images, certificacao, episodeProgressList, continueEp] =
    await Promise.all([
      prisma.episodio.findMany({
        where: { serieId: serie.id },
        orderBy: [{ temporada: "asc" }, { numeroEp: "asc" }],
        // Select explicito: sem ele a linha inteira vinha do Postgres e ia
        // parar no client component, urlDub/urlLeg incluidos.
        select: {
          id: true, serieId: true, temporada: true, numeroEp: true,
          titulo: true, thumbnail: true, createdAt: true,
          urlDub: true, urlLeg: true,
        },
      }),
      serie.tmdbId ? getTVVideos(serie.tmdbId) : null,
      serie.tmdbId ? getTVCredits(serie.tmdbId) : null,
      serie.tmdbId ? getSerie(serie.tmdbId) : null,
      serie.tmdbId ? getTVRecommendations(serie.tmdbId) : null,
      serie.tmdbId ? getTVImages(serie.tmdbId) : null,
      serie.tmdbId ? getTVCertification(serie.tmdbId) : null,
      userId
        ? prisma.watchHistory.findMany({
            where: { userId, serieId: serie.id, episodioId: { not: null } },
            select: { episodioId: true, progressoSeg: true, duracaoSeg: true, concluido: true },
          })
        : Promise.resolve([]),
      userId
        ? prisma.watchHistory.findFirst({
            where: { userId, serieId: serie.id, concluido: false, progressoSeg: { gt: 30 } },
            orderBy: { updatedAt: "desc" },
            select: { temporada: true, numeroEp: true },
          })
        : Promise.resolve(null),
    ]);

  const progressoMap: Record<string, { progressoSeg: number; duracaoSeg: number | null; concluido: boolean }> =
    Object.fromEntries(
      episodeProgressList.map((p) => [
        p.episodioId!,
        { progressoSeg: p.progressoSeg, duracaoSeg: p.duracaoSeg ?? null, concluido: p.concluido },
      ])
    );

  // EpisodeGrid e client component: o que atravessa vira payload publico, entao
  // a URL da fonte fica aqui e so a disponibilidade segue adiante.
  const episodiosPublicos = episodios.map(({ urlDub, urlLeg, ...ep }) => ({
    ...ep,
    dub: Boolean(urlDub),
    leg: Boolean(urlLeg),
  }));

  const temporadas = Array.from(new Set(episodios.map((e) => e.temporada))).sort((a, b) => a - b);

  // Notas por episódio via TMDB (uma chamada por temporada, cacheadas 1h)
  const seasonDetailsArr = serie.tmdbId
    ? await Promise.all(temporadas.map((t) => getTVSeasonDetails(serie.tmdbId!, t)))
    : [];

  const epRatingMap: Record<string, number> = {};
  const epMetadataMap: Record<string, { overview: string | null; runtime: number | null; thumbnail: string | null }> = {};
  for (const season of seasonDetailsArr) {
    if (!season?.episodes) continue;
    for (const ep of season.episodes) {
      if (ep.vote_average > 0) {
        epRatingMap[`${ep.season_number}_${ep.episode_number}`] = ep.vote_average;
      }
      epMetadataMap[`${ep.season_number}_${ep.episode_number}`] = {
        overview: ep.overview?.trim() || null,
        runtime: ep.runtime ?? null,
        thumbnail: ep.still_path ?? null,
      };
    }
  }

  const trailer = pickTrailer(videos?.results);
  const cast = (credits?.cast ?? []).slice(0, 16);
  const creativePeople = new Map<number, PeopleRowItem>();
  for (const person of tmdbDetails?.created_by ?? []) {
    creativePeople.set(person.id, { ...person, role: "Criação" });
  }
  for (const person of credits?.crew ?? []) {
    const directed = person.job === "Director" || person.jobs?.some((job) => job.job === "Director");
    if (!directed) continue;
    const current = creativePeople.get(person.id);
    creativePeople.set(person.id, {
      id: person.id,
      name: person.name,
      profile_path: person.profile_path,
      role: current ? "Criação e direção" : "Direção",
    });
  }

  // Logo transparente e backdrop sem texto queimado para o hero.
  const heroLogo = serie.logo ?? pickLogo(images);
  const heroBackdrop = serie.background ?? pickHeroBackdrop(images);

  // Botão principal: retoma de onde parou, senão abre o primeiro episódio.
  const primeiroEp = episodios[0];
  const alvo = continueEp ?? (primeiroEp ? { temporada: primeiroEp.temporada, numeroEp: primeiroEp.numeroEp } : null);
  const watchHref = alvo ? `/assistir/serie/${serie.id}/t${alvo.temporada}/ep${alvo.numeroEp}` : null;
  const watchLabel = alvo
    ? continueEp
      ? `Continuar T${alvo.temporada} E${alvo.numeroEp}`
      : `Assistir T${alvo.temporada} E${alvo.numeroEp}`
    : "Assistir";

  // TMDB recommendations → match with DB
  let recCards: any[] = [];
  if (tmdbRecs?.results?.length) {
    const tmdbIds = tmdbRecs.results.map((r: any) => String(r.id));
    const dbRecs = await prisma.serie.findMany({
      where: { tmdbId: { in: tmdbIds } },
      select: { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true, tipo: true },
    });
    recCards = dbRecs.map((s) => ({ ...s, tipo: s.tipo as any }));
  }

  // Fallback: series do mesmo gênero
  if (!recCards.length) {
    const generoIds = serie.generos.map((g: any) => g.generoId);
    const fallback = await prisma.serie.findMany({
      where: { id: { not: serie.id }, generos: { some: { generoId: { in: generoIds } } } },
      take: 20,
      select: { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true, tipo: true },
    });
    recCards = fallback.map((s) => ({ ...s, tipo: s.tipo as any }));
  }

  const sectionLabel = serie.tipo === "anime" ? "Animes" : serie.tipo === "desenho" ? "Desenhos" : "Séries";
  const sectionHref = serie.tipo === "anime" ? "/animes" : serie.tipo === "desenho" ? "/desenhos" : "/series";
  const genres = serie.generos.map((item: any) => item.genero.nome);
  const seriesSchema = {
    "@context": "https://schema.org",
    "@type": "TVSeries",
    name: serie.titulo,
    alternateName: serie.tituloOriginal || undefined,
    description: serie.sinopse || undefined,
    image: serie.poster ? imgUrl(serie.poster, "w500") : undefined,
    dateCreated: serie.ano ? String(serie.ano) : undefined,
    numberOfSeasons: serie.temporadas || temporadas.length || undefined,
    numberOfEpisodes: episodios.length || undefined,
    genre: genres,
    contentRating: certificacao || undefined,
    actor: cast.map((person: any) => ({ "@type": "Person", name: person.name })),
    aggregateRating: serie.nota && serie.voteCount && serie.voteCount > 0 ? {
      "@type": "AggregateRating",
      ratingValue: serie.nota,
      bestRating: 10,
      worstRating: 0,
      ratingCount: serie.voteCount,
    } : undefined,
    url: absoluteUrl(`/serie/${serie.id}`),
    identifier: serie.imdbId || serie.tmdbId || serie.id,
    inLanguage: "pt-BR",
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: absoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: sectionLabel, item: absoluteUrl(sectionHref) },
      { "@type": "ListItem", position: 3, name: serie.titulo, item: absoluteUrl(`/serie/${serie.id}`) },
    ],
  };

  return (
    <div className="min-h-screen">
      <JsonLd data={[seriesSchema, breadcrumbSchema]} />

      <MediaHero
        conteudoId={serie.id}
        tipo={serie.tipo as any}
        titulo={serie.titulo}
        tituloOriginal={serie.tituloOriginal}
        backdrop={heroBackdrop}
        logo={heroLogo}
        sinopse={serie.sinopse}
        ano={serie.ano}
        certificacao={certificacao}
        nota={serie.nota}
        imdbId={serie.imdbId}
        temporadas={temporadas.length || serie.temporadas}
        top250={serie.top250}
        generos={serie.generos.map((g: any) => ({ id: g.generoId, nome: g.genero.nome }))}
        watchHref={watchHref}
        watchLabel={watchLabel}
        trailerKey={trailer?.key}
        shareUrl={absoluteUrl(`/serie/${serie.id}`)}
      />

      {/* Temporadas e episódios logo abaixo do hero */}
      {temporadas.length > 0 && (
        <div className="px-4 pt-2 md:px-14 md:pt-4">
          <EpisodeGrid
            serieId={serie.id}
            episodios={episodiosPublicos}
            temporadas={temporadas}
            progresso={progressoMap}
            ratingMap={epRatingMap}
            metadataMap={epMetadataMap}
            initialSeason={continueEp?.temporada ?? temporadas[0]}
          />
        </div>
      )}

      <div className="px-4 pb-4 pt-8 md:px-14">
        <Breadcrumbs items={[{ label: "Início", href: "/" }, { label: sectionLabel, href: sectionHref }, { label: serie.titulo }]} />

        <PeopleRow title="Criação e direção" people={[...creativePeople.values()]} />
        <PeopleRow
          title="Elenco principal"
          people={cast.map((person) => ({
            ...person,
            role: person.character ?? person.roles?.[0]?.character,
          }))}
        />
      </div>

      {/* Recomendações */}
      {recCards.length > 0 && (
        <div className="pb-16 pt-4">
          <LandscapeRow titulo="Você Também Pode Gostar" items={recCards} />
        </div>
      )}
    </div>
  );
}
