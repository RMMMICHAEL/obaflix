import { notFound } from "next/navigation";
import {
  imgUrl,
  getMovieVideos,
  getMovieCredits,
  getMovieRecommendations,
  getMovieImages,
  getMovieCertification,
  pickTrailer,
  pickLogo,
  pickHeroBackdrop,
} from "@/lib/tmdb";
import { prisma } from "@/lib/prisma";
import { LandscapeRow } from "@/components/ui/LandscapeRow";
import { MediaHero } from "@/components/ui/MediaHero";
import { PeopleRow } from "@/components/ui/PeopleRow";
import { EstadoPessoalProvider } from "@/components/ui/EstadoPessoal";
import { Breadcrumbs } from "@/components/seo/Breadcrumbs";
import { JsonLd } from "@/components/seo/JsonLd";
import { absoluteUrl, mediaMetadata } from "@/lib/seo";

// Pagina publica e igual para todo mundo: nada de sessao entra no render, o que
// permite servir do cache. O estado do usuario chega depois, via EstadoPessoal.
// 6h e folgado porque a linha so muda quando o sync escreve — e quando escreve,
// o proprio sync revalida o caminho deste id.
export const revalidate = 21600;

/**
 * Vazio de proposito: nao prerendera nada no build (sao 25 mil filmes), mas e o
 * que faz a rota dinamica entrar no cache de rota. Sem isto o Next trata cada
 * /filme/:id como render sob demanda e devolve `no-store`, e o `revalidate`
 * acima nao vale de nada.
 */
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  const filme = await prisma.filme.findUnique({
    where: { id: params.id },
    select: { titulo: true, sinopse: true, background: true, poster: true, ano: true },
  });
  if (!filme) return { title: "Filme não encontrado", robots: { index: false, follow: false } };

  const title = filme.ano ? `${filme.titulo} (${filme.ano})` : filme.titulo;
  const image = filme.background ?? filme.poster;
  return mediaMetadata({
    title,
    description: filme.sinopse,
    path: `/filme/${params.id}`,
    image: image ? imgUrl(image, "original") : null,
    type: "video.movie",
  });
}

export default async function FilmePage({ params }: { params: { id: string } }) {
  const filme = await prisma.filme.findUnique({
    where: { id: params.id },
    include: { generos: { include: { genero: true } } },
  });

  if (!filme) notFound();

  const generoIds = filme.generos.map((g: any) => g.generoId);

  // Fetch TMDB data + DB similares in parallel
  const [videos, credits, tmdbRecs, images, certificacao, dbSimilares] = await Promise.all([
    filme.tmdbId ? getMovieVideos(filme.tmdbId) : null,
    filme.tmdbId ? getMovieCredits(filme.tmdbId) : null,
    filme.tmdbId ? getMovieRecommendations(filme.tmdbId) : null,
    filme.tmdbId ? getMovieImages(filme.tmdbId) : null,
    filme.tmdbId ? getMovieCertification(filme.tmdbId) : null,
    prisma.filme.findMany({
      where: { id: { not: filme.id }, generos: { some: { generoId: { in: generoIds } } } },
      take: 20,
      // Sem urlDub/urlLeg: o card de similares nunca mostrou badge de audio, e
      // ler a URL aqui so serviria para ela vazar no payload do cliente.
      select: { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true },
    }),
  ]);

  const trailer = pickTrailer(videos?.results);
  const cast = (credits?.cast ?? []).slice(0, 16);
  const directors = (credits?.crew ?? [])
    .filter((person) => person.job === "Director")
    .filter((person, index, all) => all.findIndex((item) => item.id === person.id) === index);

  // Logo transparente e backdrop sem texto queimado para o hero.
  const heroLogo = filme.logo ?? pickLogo(images);
  const heroBackdrop = filme.background ?? pickHeroBackdrop(images);

  // If TMDB has recommendations, try to match with our DB
  let recCards: any[] = [];
  if (tmdbRecs?.results?.length) {
    const tmdbIds = tmdbRecs.results.map((r: any) => String(r.id));
    const dbRecs = await prisma.filme.findMany({
      where: { tmdbId: { in: tmdbIds } },
      // Sem urlDub/urlLeg: o card de similares nunca mostrou badge de audio, e
      // ler a URL aqui so serviria para ela vazar no payload do cliente.
      select: { id: true, titulo: true, poster: true, background: true, logo: true, ano: true, nota: true },
    });
    recCards = dbRecs.map((f) => ({ ...f, tipo: "filme" as const }));
  }

  const similares = (recCards.length > 0 ? recCards : dbSimilares).map((f) => ({
    ...f,
    tipo: "filme" as const,
  }));

  const genres = filme.generos.map((item: any) => item.genero.nome);
  const movieSchema = {
    "@context": "https://schema.org",
    "@type": "Movie",
    name: filme.titulo,
    alternateName: filme.tituloOriginal || undefined,
    description: filme.sinopse || undefined,
    image: filme.poster ? imgUrl(filme.poster, "w500") : undefined,
    dateCreated: filme.ano ? String(filme.ano) : undefined,
    duration: filme.duracao ? `PT${Math.floor(filme.duracao / 60)}H${filme.duracao % 60}M` : undefined,
    genre: genres,
    contentRating: certificacao || undefined,
    actor: cast.map((person: any) => ({ "@type": "Person", name: person.name })),
    aggregateRating: filme.nota && filme.voteCount && filme.voteCount > 0 ? {
      "@type": "AggregateRating",
      ratingValue: filme.nota,
      bestRating: 10,
      worstRating: 0,
      ratingCount: filme.voteCount,
    } : undefined,
    url: absoluteUrl(`/filme/${filme.id}`),
    identifier: filme.imdbId || filme.tmdbId || filme.id,
    inLanguage: "pt-BR",
  };
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Início", item: absoluteUrl("/") },
      { "@type": "ListItem", position: 2, name: "Filmes", item: absoluteUrl("/filmes") },
      { "@type": "ListItem", position: 3, name: filme.titulo, item: absoluteUrl(`/filme/${filme.id}`) },
    ],
  };

  return (
    <EstadoPessoalProvider conteudoId={filme.id} tipo="filme">
    <div className="min-h-screen">
      <JsonLd data={[movieSchema, breadcrumbSchema]} />

      <MediaHero
        conteudoId={filme.id}
        tipo="filme"
        titulo={filme.titulo}
        tituloOriginal={filme.tituloOriginal}
        backdrop={heroBackdrop}
        logo={heroLogo}
        sinopse={filme.sinopse}
        ano={filme.ano}
        certificacao={certificacao}
        nota={filme.nota}
        imdbId={filme.imdbId}
        duracaoMin={filme.duracao}
        top250={filme.top250}
        generos={filme.generos.map((g: any) => ({ id: g.generoId, nome: g.genero.nome }))}
        watchHref={`/assistir/filme/${filme.id}`}
        trailerKey={trailer?.key}
        dub={!!filme.urlDub}
        leg={!!filme.urlLeg}
        shareUrl={absoluteUrl(`/filme/${filme.id}`)}
      />

      <div className="px-4 pb-4 md:px-14">
        <Breadcrumbs items={[{ label: "Início", href: "/" }, { label: "Filmes", href: "/filmes" }, { label: filme.titulo }]} />

        <PeopleRow
          title="Direção"
          people={directors.map((person) => ({ ...person, role: "Diretor(a)" }))}
        />
        <PeopleRow
          title="Elenco principal"
          people={cast.map((person) => ({ ...person, role: person.character }))}
        />
      </div>

      {/* Recommendations */}
      {similares.length > 0 && (
        <div className="pb-16 pt-4">
          <LandscapeRow titulo="Você Também Pode Gostar" items={similares} />
        </div>
      )}
    </div>
    </EstadoPessoalProvider>
  );
}
