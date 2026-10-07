import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  imgUrl,
  getTVVideos,
  getTVSeasonDetails,
  getTVImages,
  getTVCertification,
  pickTrailer,
  pickLogo,
  pickHeroBackdrop,
} from "@/lib/tmdb";
import { extrairMetadataEpisodios } from "@/lib/tmdbEpisodios";
import { prisma } from "@/lib/prisma";
import { EpisodeGrid } from "./EpisodeGrid";
import { SerieCreditos, SerieRecomendacoes } from "./SerieSecundario";
import { EstadoPessoalProvider } from "@/components/ui/EstadoPessoal";
import { BannerDesktop } from "@/components/ads/BannerDesktop";
import { MediaHero } from "@/components/ui/MediaHero";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { absoluteUrl, mediaMetadata, tituloFicha, descricaoFicha } from "@/lib/seo";
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

  // Intenção "assistir <título> online"; o template do layout acrescenta
  // " | Obaflix". A description combina a chamada de intenção com a sinopse real
  // — mesma string vai para OG/Twitter via mediaMetadata. Canonical slug--id.
  const image = serie.background ?? serie.poster;
  return mediaMetadata({
    title: tituloFicha("serie", serie.titulo),
    description: descricaoFicha("serie", serie.titulo, serie.sinopse),
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

  // ── Caminho crítico: só o necessário para a ficha ficar utilizável ──────────
  // Série + episódios (Prisma), trailer e classificação do hero, e imagens do
  // TMDB APENAS quando faltar arte local. Elenco, direção, recomendações e o
  // JSON-LD da série (que depende do elenco) saem daqui para <Suspense> abaixo.
  const precisaImagens = !serie.background || !serie.logo;
  const [episodios, videos, certificacao, images] = await Promise.all([
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
    serie.tmdbId ? getTVCertification(serie.tmdbId) : null,
    // Só busca imagens se faltar backdrop OU logo local — senão a arte do banco
    // basta e a chamada ao TMDB é evitada.
    precisaImagens && serie.tmdbId ? getTVImages(serie.tmdbId) : null,
  ]);

  // EpisodeGrid e client component: o que atravessa vira payload publico, entao
  // a URL da fonte fica aqui e so a disponibilidade segue adiante.
  const episodiosPublicos = episodios.map(({ urlDub, urlLeg, ...ep }) => ({
    ...ep,
    dub: Boolean(urlDub),
    leg: Boolean(urlLeg),
  }));

  // Disponibilidade de áudio da série: só os booleanos derivados — a URL nunca
  // sai do servidor. Alimenta a frase visível do bloco SEO.
  const temDub = episodiosPublicos.some((e) => e.dub);
  const temLeg = episodiosPublicos.some((e) => e.leg);

  const temporadas = Array.from(new Set(episodios.map((e) => e.temporada))).sort((a, b) => a - b);

  // Só a PRIMEIRA temporada entra no caminho crítico (uma chamada, não mais o
  // Promise.all sobre TODAS as temporadas). As outras temporadas buscam seus
  // metadados sob demanda pelo EpisodeGrid, quando selecionadas.
  const initialSeason = temporadas[0];
  const initialSeasonDetails =
    serie.tmdbId && initialSeason != null
      ? await getTVSeasonDetails(serie.tmdbId, initialSeason)
      : null;
  const { ratingMap: epRatingMap, metadataMap: epMetadataMap } = extrairMetadataEpisodios([
    initialSeasonDetails,
  ]);

  const trailer = pickTrailer(videos?.results);

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

  const canonicalUrl = absoluteUrl(catalogPath("serie", serie.id, serie.titulo));
  const generosLinks = serie.generos.map((g: any) => ({ id: g.generoId, nome: g.genero.nome }));
  const genres = serie.generos.map((item: any) => item.genero.nome);
  const generoIds = serie.generos.map((g: any) => g.generoId);

  // Frase derivada SÓ de dados reais: contagem de temporadas e episódios.
  const nTemporadas = temporadas.length || serie.temporadas || 0;
  const nEpisodios = episodios.length;
  const descricaoTemporadas =
    nEpisodios > 0
      ? `${serie.titulo} possui ${nTemporadas} ${nTemporadas === 1 ? "temporada" : "temporadas"} e ${nEpisodios} ${nEpisodios === 1 ? "episódio" : "episódios"} disponíveis no catálogo.`
      : null;
  // O JSON-LD da série (TVSeries, com `actor` do elenco) é emitido pelo
  // SerieCreditos no <Suspense> — o conteúdo é idêntico, só sai do caminho
  // crítico porque depende do elenco. O breadcrumb, que não depende do TMDB,
  // continua crítico.
  const numberOfSeasons = serie.temporadas || temporadas.length;

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
      <JsonLd data={breadcrumbSchema} />

      <MediaHero
        conteudoId={serie.id}
        tipo={serie.tipo as any}
        titulo={serie.titulo}
        heading={`Assistir ${serie.titulo} online`}
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

        {/* Elenco/direção + JSON-LD da série: fora do caminho crítico. Chegam
            abaixo do hero/episódios, sem segurar a parte principal. */}
        <Suspense fallback={null}>
          <SerieCreditos
            serie={serie}
            genres={genres}
            certificacao={certificacao}
            canonicalUrl={canonicalUrl}
            numberOfSeasons={numberOfSeasons}
            numberOfEpisodes={nEpisodios}
          />
        </Suspense>
      </div>

      {/* Conteúdos parecidos: cards são links HTML reais. Também fora do
          caminho crítico — aparecem quando os dados chegarem. */}
      <Suspense fallback={null}>
        <SerieRecomendacoes
          serieId={serie.id}
          tmdbId={serie.tmdbId}
          serieTitulo={serie.titulo}
          generoIds={generoIds}
        />
      </Suspense>

      <FichaSeoExtra titulo={serie.titulo} tipo="serie" generos={generosLinks} dub={temDub} leg={temLeg} />
    </div>
    </AcquisitionProvider>
    </EstadoPessoalProvider>
  );
}
