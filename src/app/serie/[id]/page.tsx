import { notFound } from "next/navigation";
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
import { EstadoPessoalProvider } from "@/components/ui/EstadoPessoal";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { BannerDesktop } from "@/components/ads/BannerDesktop";
import { MediaHero } from "@/components/ui/MediaHero";
import { PeopleRow, type PeopleRowItem } from "@/components/ui/PeopleRow";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { absoluteUrl, mediaMetadata } from "@/lib/seo";
import { AcquisitionProvider } from "@/components/catalog/AcquisitionProvider";
import { FichaSeoExtra } from "@/components/catalog/FichaSeoExtra";
import { WEB_STREAMING_ENABLED } from "@/config/site-mode";
import { catalogPath, catalogSlugId, parseSeoParam } from "@/lib/catalog-url";
import { permanentRedirect } from "next/navigation";

/**
 * Publica e igual para todo mundo; progresso e continuar assistindo chegam pelo
 * EstadoPessoal depois da hidratacao.
 *
 * ISR com TTL longo — ver a nota longa em /filme/[id], inclusive por que
 * `force-dynamic` + Cache-Control no next.config NAO serve na Vercel.
 *
 * 6h e nao 24h: serie no ar ganha episodio, e o `revalidatePath` do sync foi
 * removido junto com a tentativa anterior. Sao no maximo 4 escritas por dia por
 * serie efetivamente acessada.
 */
export const revalidate = 21600;

/** Vazio de proposito — ver a nota em /filme/[id]. */
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  const id = parseSeoParam(params.id);
  const serie = await prisma.serie.findUnique({
    where: { id },
    select: { titulo: true, sinopse: true, background: true, poster: true, ano: true, tipo: true },
  });
  if (!serie) return { title: "Série não encontrada", robots: { index: false, follow: false } };

  // "temporadas, episódios e onde assistir" cobre o intento de busca da série; o
  // template do layout acrescenta " | Obaflix". A description segue a sinopse
  // real (única por título), sem texto repetido entre páginas. Canonical slug--id.
  const title = `${serie.titulo} — temporadas, episódios e onde assistir`;
  const image = serie.background ?? serie.poster;
  return mediaMetadata({
    title,
    description: serie.sinopse,
    path: catalogPath("serie", id, serie.titulo),
    image: image ? imgUrl(image, "original") : null,
    type: "video.tv_show",
  });
}

export default async function SeriePage({ params }: { params: { id: string } }) {
  const id = parseSeoParam(params.id);
  const serie = await prisma.serie.findUnique({
    where: { id },
    include: { generos: { include: { genero: true } } },
  });

  if (!serie) notFound();

  // Uma URL canônica por série: slug divergente ou ID puro legado → 308 para
  // `<slug>--<id>`. anime/desenho também vivem em `/serie/<...>`.
  if (params.id !== catalogSlugId(serie.titulo, serie.id)) {
    permanentRedirect(catalogPath("serie", serie.id, serie.titulo));
  }

  const [episodios, videos, credits, tmdbDetails, tmdbRecs, images, certificacao] =
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
    ]);

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

  // Botao principal na versao neutra: primeiro episodio. Se o usuario tiver onde
  // retomar, o MediaHero troca href e rotulo quando o estado pessoal chega.
  const primeiroEp = episodios[0];
  const watchHref = primeiroEp
    ? `/assistir/serie/${serie.id}/t${primeiroEp.temporada}/ep${primeiroEp.numeroEp}`
    : null;
  const watchLabel = primeiroEp ? `Assistir T${primeiroEp.temporada} E${primeiroEp.numeroEp}` : "Assistir";

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

  const canonicalUrl = absoluteUrl(catalogPath("serie", serie.id, serie.titulo));
  const generosLinks = serie.generos.map((g: any) => ({ id: g.generoId, nome: g.genero.nome }));
  const genres = serie.generos.map((item: any) => item.genero.nome);

  // Frase derivada SÓ de dados reais: contagem de temporadas e episódios.
  const nTemporadas = temporadas.length || serie.temporadas || 0;
  const nEpisodios = episodios.length;
  const descricaoTemporadas =
    nEpisodios > 0
      ? `${serie.titulo} possui ${nTemporadas} ${nTemporadas === 1 ? "temporada" : "temporadas"} e ${nEpisodios} ${nEpisodios === 1 ? "episódio" : "episódios"} disponíveis no catálogo.`
      : null;
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
    url: canonicalUrl,
    identifier: serie.imdbId || serie.tmdbId || serie.id,
    inLanguage: "pt-BR",
  };
  // Série "pura" ganha o degrau Séries (/series já é página pública, Fase 2).
  // Anime e desenho seguem Início › Título por enquanto: /animes e /desenhos
  // ainda não têm versão pública para navegador comum. Visual e JSON-LD
  // concordam.
  const ehSeriePura = serie.tipo === "serie";
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: absoluteUrl("/") },
      ...(ehSeriePura
        ? [{ "@type": "ListItem", position: 2, name: "Séries", item: absoluteUrl("/series") }]
        : []),
      { "@type": "ListItem", position: ehSeriePura ? 3 : 2, name: serie.titulo, item: canonicalUrl },
    ],
  };

  return (
    <EstadoPessoalProvider conteudoId={serie.id} tipo="serie">
    <AcquisitionProvider streamingAberto={WEB_STREAMING_ENABLED}>
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
        // Mesma coleção que alimenta o EpisodeGrid abaixo: o hero e a lista não
        // podem discordar sobre quantos episódios existem. Só as ações de
        // Baixar/Transmitir do Android usam isto — quando há mais de um
        // episódio elas levam à lista em vez de escolher por conta própria.
        totalEpisodios={episodiosPublicos.length}
        episodioUnico={
          episodiosPublicos.length === 1
            ? {
                temporada: episodiosPublicos[0].temporada,
                numeroEp: episodiosPublicos[0].numeroEp,
              }
            : null
        }
        trailerKey={trailer?.key}
        shareUrl={canonicalUrl}
      />

      {/* Abaixo do hero, no fluxo: não cobre Assistir/Trailer nem as informações.
          Só no app Windows; em qualquer outro ambiente não renderiza nada. */}
      <BannerDesktop posicao="detalhe" />

      {/* Temporadas e episódios logo abaixo do hero */}
      {temporadas.length > 0 && (
        // O id é o destino de "Baixar"/"Transmitir" do hero quando ainda não há
        // um episódio escolhido: em vez de decidir por conta própria, a ação
        // leva até aqui. `scroll-mt` desconta o cabeçalho fixo, senão o topo da
        // lista para debaixo dele e a pessoa não vê o que foi destacado.
        <div id="episodios" className="scroll-mt-24 px-4 pt-2 md:px-14 md:pt-4">
          <h2 className="text-lg font-bold text-white md:text-xl">
            Temporadas e episódios de {serie.titulo}
          </h2>
          {descricaoTemporadas ? (
            <p className="mb-4 mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400 md:text-[15px]">
              {descricaoTemporadas}
            </p>
          ) : (
            <div className="mb-2" />
          )}
          <EpisodeGrid
            serieId={serie.id}
            serieTitulo={serie.titulo}
            episodios={episodiosPublicos}
            temporadas={temporadas}
            ratingMap={epRatingMap}
            metadataMap={epMetadataMap}
            initialSeason={temporadas[0]}
          />
        </div>
      )}

      <div className="px-4 pb-4 pt-8 md:px-14">
        <Breadcrumbs
          items={[
            { label: "Início", href: "/" },
            ...(ehSeriePura ? [{ label: "Séries", href: "/series" }] : []),
            { label: serie.titulo },
          ]}
        />

        <PeopleRow title="Criação e direção" people={[...creativePeople.values()]} />
        <PeopleRow
          title="Elenco principal"
          people={cast.map((person) => ({
            ...person,
            role: person.character ?? person.roles?.[0]?.character,
          }))}
        />
      </div>

      {/* Conteúdos parecidos: cards são links HTML reais para as fichas. */}
      {recCards.length > 0 && (
        <div className="pt-4">
          <LandscapeRow titulo={`Conteúdos parecidos com ${serie.titulo}`} items={recCards} />
        </div>
      )}

      <FichaSeoExtra titulo={serie.titulo} tipo="serie" generos={generosLinks} />
    </div>
    </AcquisitionProvider>
    </EstadoPessoalProvider>
  );
}
